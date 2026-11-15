import Foundation
import AVFoundation

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
    public let estimatedRamGB: Double
}

/// Native iOS whisper.cpp (small.q5_1 Metal + CoreML Encoder) Adapter für iPhone 16 Pro Max.
public final class WhisperMetalAdapter: @unchecked Sendable {
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
        return WhisperDeploymentDiagnostics(
            modelId: modelId,
            status: "NATIVE APP INTEGRATION ERFORDERLICH",
            runtime: "whisper.cpp Metal GPU + CoreML ANE Encoder (16 kHz PCM -> SRT)",
            deviceModel: "iPhone 16 Pro Max (A18 Pro · ~0,2x Echtzeit)",
            weightsPresent: url != nil,
            estimatedRamGB: estimatedRamGB
        )
    }

    public func loadAudioAs16kMonoFloat(audioURL: URL) throws -> [Float] {
        let file = try AVAudioFile(forReading: audioURL)
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

        let ratio = 16_000.0 / file.processingFormat.sampleRate
        let outFrameCapacity = AVAudioFrameCount(Double(file.length) * ratio) + 1024
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
        var consumed = false
        var err: NSError?
        converter.convert(to: outputBuf, error: &err) { _, outStatus in
            if consumed {
                outStatus.pointee = .endOfStream
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return inputBuf
        }
        if let err {
            throw WhisperAdapterError.invalidAudioFormat(err.localizedDescription)
        }
        guard let ptr = outputBuf.floatChannelData?[0] else {
            throw WhisperAdapterError.invalidAudioFormat("Keine Float-Samples erhalten.")
        }
        return Array(UnsafeBufferPointer(start: ptr, count: Int(outputBuf.frameLength)))
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
