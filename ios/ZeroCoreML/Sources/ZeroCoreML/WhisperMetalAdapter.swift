import Foundation
@preconcurrency import AVFoundation

private final class AudioConverterInputState: @unchecked Sendable {
    private let lock = NSLock()
    private let buffer: AVAudioPCMBuffer
    private var didProvideBuffer = false

    init(buffer: AVAudioPCMBuffer) {
        self.buffer = buffer
    }

    func nextBuffer(status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
        lock.lock()
        defer { lock.unlock() }

        guard !didProvideBuffer else {
            status.pointee = .endOfStream
            return nil
        }

        didProvideBuffer = true
        status.pointee = .haveData
        return buffer
    }
}

public struct WhisperSegment: Codable, Sendable {
    public let index: Int
    public let startTimeMs: Int
    public let endTimeMs: Int
    public let text: String

    public func formatSrtTimestamp(_ ms: Int) -> String {
        let hours = ms / 3_600_000
        let mins = (ms % 3_600_000) / 60_000
        let secs = (ms % 60_000) / 1000
        let remMs = ms % 1000
        return String(format: "%02d:%02d:%02d,%03d", hours, mins, secs, remMs)
    }

    public var srtBlock: String {
        "\(index)\n\(formatSrtTimestamp(startTimeMs)) --> \(formatSrtTimestamp(endTimeMs))\n\(text)"
    }
}

public protocol WhisperMetalCBridge: Sendable {
    func transcribe16kHzPCM(
        modelURL: URL,
        samples: [Float],
        languageCode: String,
        threadCount: Int
    ) async throws -> [WhisperSegment]
}

public enum WhisperAdapterError: Error, LocalizedError, Sendable {
    case ggmlWeightsMissing(String)
    case bridgeNotLinked
    case invalidAudioFormat(String)

    public var errorDescription: String? {
        switch self {
        case .ggmlWeightsMissing(let name):
            return "whisper.cpp Gewicht '\(name)' fehlt im App-Bundle oder Documents/ZeroModels."
        case .bridgeNotLinked:
            return "whisper.cpp XCFramework / Metal Bridge noch nicht im Xcode-Target verlinkt."
        case .invalidAudioFormat(let detail):
            return "Audio konnte nicht auf 16 kHz Mono PCM konvertiert werden: \(detail)"
        }
    }
}

public struct WhisperDeploymentDiagnostics: Codable, Sendable {
    public let modelId: String
    public let status: String
    public let runtime: String
    public let deviceModel: String
    public let weightsPresent: Bool
    public let runtimeLinked: Bool
    public let estimatedRamGB: Double
}

/// Whisper audio preparation and guarded bridge adapter. No concrete whisper.cpp runtime is bundled or linked by this package.
public final class WhisperMetalAdapter: Sendable {
    public let modelId = "whisper-cpp-small"
    public let weightsFilename = "ggml-small.q5_1.bin"
    public let estimatedRamGB = 0.50
    private let bridge: WhisperMetalCBridge?

    public init(bridge: WhisperMetalCBridge? = nil) {
        self.bridge = bridge
    }

    public static func locateModelURL(
        filename: String = "ggml-small.q5_1.bin",
        bundle: Bundle = .main,
        documentsDirectory: URL? = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    ) -> URL? {
        let base = filename.replacingOccurrences(of: ".bin", with: "")
        if let bundled = bundle.url(forResource: base, withExtension: "bin") {
            return bundled
        }
        if let docs = documentsDirectory {
            let candidate = docs
                .appendingPathComponent("ZeroModels", isDirectory: true)
                .appendingPathComponent(filename)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

    public func deploymentDiagnostics() -> WhisperDeploymentDiagnostics {
        let url = Self.locateModelURL(filename: weightsFilename)
        let runtimeLinked = bridge != nil
        let weightsPresent = url != nil
        let status = runtimeLinked && weightsPresent
            ? "RUNTIME_UND_MODELLGEWICHTE_VORHANDEN"
            : (!runtimeLinked ? "WHISPER_CPP_RUNTIME_NICHT_VERLINKT" : "WHISPER_MODELLGEWICHTE_FEHLEN")
        return WhisperDeploymentDiagnostics(
            modelId: modelId,
            status: status,
            runtime: runtimeLinked
                ? "whisper.cpp Bridge injiziert; Metal/CoreML-Inferenz separat zu verifizieren"
                : "Keine konkrete whisper.cpp XCFramework-/C-Bridge-Implementierung verlinkt",
            deviceModel: "Gerätemodell und Echtzeitfaktor nicht verifiziert",
            weightsPresent: weightsPresent,
            runtimeLinked: runtimeLinked,
            estimatedRamGB: estimatedRamGB
        )
    }

    public func loadAudioAs16kMonoFloat(audioURL: URL) throws -> [Float] {
        let file: AVAudioFile
        do {
            file = try AVAudioFile(forReading: audioURL)
        } catch {
            throw WhisperAdapterError.invalidAudioFormat(
                "Audiodatei kann nicht geöffnet werden: \(error.localizedDescription)"
            )
        }
        guard file.length > 0 else {
            throw WhisperAdapterError.invalidAudioFormat("Audiodatei enthält keine Audio-Frames.")
        }
        guard file.length <= Int64(UInt32.max) else {
            throw WhisperAdapterError.invalidAudioFormat("Audiodatei ist für einen einzelnen PCM-Puffer zu groß.")
        }
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false
        ) else {
            throw WhisperAdapterError.invalidAudioFormat("PCM 16kHz Format nicht initialisierbar.")
        }
        guard let converter = AVAudioConverter(from: file.processingFormat, to: targetFormat) else {
            throw WhisperAdapterError.invalidAudioFormat("AVAudioConverter fehlgeschlagen.")
        }

        let sourceSampleRate = file.processingFormat.sampleRate
        guard sourceSampleRate.isFinite, sourceSampleRate > 0 else {
            throw WhisperAdapterError.invalidAudioFormat("Ungültige Abtastrate der Audiodatei.")
        }
        let ratio = 16_000.0 / sourceSampleRate
        let outputCapacity = Double(file.length) * ratio + 1024
        guard outputCapacity.isFinite, outputCapacity > 0, outputCapacity <= Double(UInt32.max) else {
            throw WhisperAdapterError.invalidAudioFormat("PCM-Ausgabepuffer überschreitet die unterstützte Größe.")
        }
        let outFrameCapacity = AVAudioFrameCount(outputCapacity)
        guard let inputBuf = AVAudioPCMBuffer(
            pcmFormat: file.processingFormat,
            frameCapacity: AVAudioFrameCount(file.length)
        ),
        let outputBuf = AVAudioPCMBuffer(
            pcmFormat: targetFormat,
            frameCapacity: outFrameCapacity
        ) else {
            throw WhisperAdapterError.invalidAudioFormat("PCM-Puffer konnte nicht alloziert werden.")
        }

        try file.read(into: inputBuf)
        let inputState = AudioConverterInputState(buffer: inputBuf)
        var err: NSError?
        let conversionStatus = converter.convert(to: outputBuf, error: &err) { _, outStatus in
            inputState.nextBuffer(status: outStatus)
        }
        if let err {
            throw WhisperAdapterError.invalidAudioFormat(err.localizedDescription)
        }
        guard conversionStatus != .error else {
            throw WhisperAdapterError.invalidAudioFormat("AVAudioConverter meldet einen Fehler ohne Detailmeldung.")
        }
        guard outputBuf.frameLength > 0 else {
            throw WhisperAdapterError.invalidAudioFormat("Audio enthält keine verwertbaren PCM-Samples.")
        }
        guard let ptr = outputBuf.floatChannelData?[0] else {
            throw WhisperAdapterError.invalidAudioFormat("Keine Float-Samples erhalten.")
        }
        let samples = Array(UnsafeBufferPointer(start: ptr, count: Int(outputBuf.frameLength)))
        guard samples.allSatisfy(\.isFinite) else {
            throw WhisperAdapterError.invalidAudioFormat("Audio enthält ungültige Float-Samples.")
        }
        return samples
    }

    public func transcribe(
        audioURL: URL,
        languageCode: String = "de"
    ) async throws -> (text: String, srt: String, segments: [WhisperSegment]) {
        guard let modelURL = Self.locateModelURL(filename: weightsFilename) else {
            throw WhisperAdapterError.ggmlWeightsMissing(weightsFilename)
        }
        guard let bridge else {
            throw WhisperAdapterError.bridgeNotLinked
        }
        let samples = try loadAudioAs16kMonoFloat(audioURL: audioURL)
        let threads = max(2, min(6, ProcessInfo.processInfo.activeProcessorCount - 2))
        let segments = try await bridge.transcribe16kHzPCM(
            modelURL: modelURL,
            samples: samples,
            languageCode: languageCode,
            threadCount: threads
        )
        let fullText = segments.map(\.text).joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        let srt = segments.map(\.srtBlock).joined(separator: "\n\n")
        return (fullText, srt, segments)
    }
}
