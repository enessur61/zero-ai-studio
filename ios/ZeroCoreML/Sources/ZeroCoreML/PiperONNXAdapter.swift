import Foundation

public struct PiperVoiceConfig: Codable, Sendable {
    public let sampleRateHz: Int
    public let noiseScale: Float
    public let lengthScale: Float
    public let noiseW: Float

    public init(
        sampleRateHz: Int = 22_050,
        noiseScale: Float = 0.667,
        lengthScale: Float = 1.0,
        noiseW: Float = 0.8
    ) {
        self.sampleRateHz = sampleRateHz
        self.noiseScale = noiseScale
        self.lengthScale = lengthScale
        self.noiseW = noiseW
    }
}

/// Converts text into the phoneme IDs expected by the selected Piper voice model.
/// A real eSpeak-ng/Piper-compatible phonemizer must be supplied by the native app.
public protocol PiperTextPhonemizer: Sendable {
    func phonemize(_ text: String, languageCode: String) async throws -> [Int64]
}

public protocol PiperONNXSessionBackend: Sendable {
    func synthesizePCM(
        onnxURL: URL,
        configURL: URL,
        phonemeIds: [Int64],
        voiceConfig: PiperVoiceConfig
    ) async throws -> [Float]
}

public enum PiperAdapterError: Error, LocalizedError, Sendable {
    case voiceFilesMissing(onnx: String, json: String)
    case onnxRuntimeNotLinked
    case phonemizerNotLinked

    public var errorDescription: String? {
        switch self {
        case .voiceFilesMissing(let onnx, let json):
            return "Piper ONNX Stimmdateien ('\(onnx)' / '\(json)') fehlen im Bundle oder Documents/ZeroModels."
        case .onnxRuntimeNotLinked:
            return "onnxruntime-swift-package-manager fehlt im Xcode-Target."
        case .phonemizerNotLinked:
            return "Piper benötigt einen kompatiblen eSpeak-ng-Phonemizer. Der native Phonemizer ist noch nicht im App-Target verlinkt."
        }
    }
}

public struct PiperDeploymentDiagnostics: Codable, Sendable {
    public let modelId: String
    public let status: String
    public let runtime: String
    public let deviceModel: String
    public let voicePresent: Bool
    public let estimatedRamGB: Double
}

/// Rhasspy Piper TTS Adapter (de_DE-thorsten-high ONNX Runtime iOS, 22.05 kHz WAV).
public final class PiperONNXAdapter: @unchecked Sendable {
    public let modelId = "piper-tts-de"
    public let onnxFilename = "de_DE-thorsten-high.onnx"
    public let configFilename = "de_DE-thorsten-high.onnx.json"
    public let estimatedRamGB = 0.15
    private let backend: PiperONNXSessionBackend?
    private let phonemizer: PiperTextPhonemizer?

    public init(
        backend: PiperONNXSessionBackend? = nil,
        phonemizer: PiperTextPhonemizer? = nil
    ) {
        self.backend = backend
        self.phonemizer = phonemizer
    }

    public static func locateVoiceFiles(
        onnxName: String = "de_DE-thorsten-high.onnx",
        jsonName: String = "de_DE-thorsten-high.onnx.json",
        bundle: Bundle = .main,
        documentsDirectory: URL? = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    ) -> (onnx: URL, config: URL)? {
        let base = onnxName.replacingOccurrences(of: ".onnx", with: "")
        if let o = bundle.url(forResource: base, withExtension: "onnx"),
           let c = bundle.url(forResource: base, withExtension: "onnx.json") {
            return (o, c)
        }
        if let docs = documentsDirectory {
            let dir = docs.appendingPathComponent("ZeroModels", isDirectory: true)
            let o = dir.appendingPathComponent(onnxName)
            let c = dir.appendingPathComponent(jsonName)
            if FileManager.default.fileExists(atPath: o.path),
               FileManager.default.fileExists(atPath: c.path) {
                return (o, c)
            }
        }
        return nil
    }

    public func deploymentDiagnostics() -> PiperDeploymentDiagnostics {
        let files = Self.locateVoiceFiles(onnxName: onnxFilename, jsonName: configFilename)
        return PiperDeploymentDiagnostics(
            modelId: modelId,
            status: "NATIVE APP INTEGRATION ERFORDERLICH",
            runtime: "ONNX Runtime iOS (de_DE-thorsten-high · 22,05 kHz PCM -> WAV)",
            deviceModel: "iPhone 16 Pro Max (CPU/CoreML EP · ~0,15 GB RAM)",
            voicePresent: files != nil,
            estimatedRamGB: estimatedRamGB
        )
    }

    /// Wandelt Float32-Samples (-1.0 ... 1.0) in eine vollständige 44-Byte RIFF-WAV Datei um.
    public static func encodeWavRIFF(samples: [Float], sampleRate: UInt32 = 22_050) -> Data {
        let dataSize = UInt32(samples.count * 2)
        var data = Data(capacity: 44 + Int(dataSize))
        func appendLE32(_ v: UInt32) {
            var le = v.littleEndian
            data.append(Data(bytes: &le, count: 4))
        }
        func appendLE16(_ v: UInt16) {
            var le = v.littleEndian
            data.append(Data(bytes: &le, count: 2))
        }

        data.append("RIFF".data(using: .ascii)!)
        appendLE32(36 + dataSize)
        data.append("WAVE".data(using: .ascii)!)
        data.append("fmt ".data(using: .ascii)!)
        appendLE32(16)
        appendLE16(1) // PCM
        appendLE16(1) // Mono
        appendLE32(sampleRate)
        appendLE32(sampleRate * 2)
        appendLE16(2)
        appendLE16(16)
        data.append("data".data(using: .ascii)!)
        appendLE32(dataSize)

        for sample in samples {
            let clamped = max(-1.0, min(1.0, sample))
            let i16 = Int16(clamped < 0 ? clamped * 32768.0 : clamped * 32767.0)
            var le = i16.littleEndian
            data.append(Data(bytes: &le, count: 2))
        }
        return data
    }

    public func synthesizeWAV(
        text: String,
        voiceConfig: PiperVoiceConfig = .init()
    ) async throws -> Data {
        guard let files = Self.locateVoiceFiles(onnxName: onnxFilename, jsonName: configFilename) else {
            throw PiperAdapterError.voiceFilesMissing(onnx: onnxFilename, json: configFilename)
        }
        guard let backend else {
            throw PiperAdapterError.onnxRuntimeNotLinked
        }
        guard let phonemizer else {
            throw PiperAdapterError.phonemizerNotLinked
        }
        // Piper ONNX erwartet sprachspezifische Phonem-IDs, keine Unicode-Codepoints.
        let phonemeIds = try await phonemizer.phonemize(text, languageCode: "de")
        guard !phonemeIds.isEmpty else {
            throw PiperAdapterError.phonemizerNotLinked
        }
        let samples = try await backend.synthesizePCM(
            onnxURL: files.onnx,
            configURL: files.config,
            phonemeIds: phonemeIds,
            voiceConfig: voiceConfig
        )
        return Self.encodeWavRIFF(samples: samples, sampleRate: UInt32(voiceConfig.sampleRateHz))
    }
}
