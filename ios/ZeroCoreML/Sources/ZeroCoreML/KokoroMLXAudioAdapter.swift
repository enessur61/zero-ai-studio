import Foundation
import CoreML

public protocol KokoroAudioBackend: Sendable {
    func synthesize24kHzPCM(
        modelURL: URL,
        voiceName: String,
        text: String,
        speed: Float
    ) async throws -> [Float]
}

public enum KokoroAdapterError: Error, LocalizedError, Sendable {
    case modelPackageMissing(String)
    case backendNotLinked

    public var errorDescription: String? {
        switch self {
        case .modelPackageMissing(let file):
            return "Kokoro-82M CoreML/MLX Paket '\(file)' fehlt in Bundle oder Documents/ZeroModels."
        case .backendNotLinked:
            return "Kokoro MLX/CoreML Audio-Backend nicht im Xcode-Target verlinkt."
        }
    }
}

public struct KokoroDeploymentDiagnostics: Codable, Sendable {
    public let modelId: String
    public let status: String
    public let runtime: String
    public let deviceModel: String
    public let modelPresent: Bool
    public let estimatedRamGB: Double
}

/// Kokoro-82M (82M Parameter) CoreML / MLX Audio Adapter für iPhone 16 Pro Max (24 kHz WAV).
public final class KokoroMLXAudioAdapter: @unchecked Sendable {
    public let modelId = "kokoro-82m"
    public let bundleName = "Kokoro-82M-v1.0.mlmodelc"
    public let estimatedRamGB = 0.80
    private let backend: KokoroAudioBackend?

    public init(backend: KokoroAudioBackend? = nil) {
        self.backend = backend
    }

    public static func locateModelURL(
        bundleName: String = "Kokoro-82M-v1.0.mlmodelc",
        bundle: Bundle = .main,
        documentsDirectory: URL? = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    ) -> URL? {
        let base = bundleName.replacingOccurrences(of: ".mlmodelc", with: "")
        if let bundled = bundle.url(forResource: base, withExtension: "mlmodelc") {
            return bundled
        }
        if let docs = documentsDirectory {
            let candidate = docs
                .appendingPathComponent("ZeroModels", isDirectory: true)
                .appendingPathComponent(bundleName, isDirectory: true)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

    public func deploymentDiagnostics() -> KokoroDeploymentDiagnostics {
        let url = Self.locateModelURL(bundleName: bundleName)
        return KokoroDeploymentDiagnostics(
            modelId: modelId,
            status: "NATIVE APP INTEGRATION ERFORDERLICH",
            runtime: "Apple CoreML / MLX Audio (82M · 24 kHz Voice Embeddings)",
            deviceModel: "iPhone 16 Pro Max (A18 Pro Neural Engine · ~0,8 GB RAM)",
            modelPresent: url != nil,
            estimatedRamGB: estimatedRamGB
        )
    }

    public func synthesizeWAV(
        text: String,
        voiceName: String = "af_heart",
        speed: Float = 1.0
    ) async throws -> Data {
        guard let url = Self.locateModelURL(bundleName: bundleName) else {
            throw KokoroAdapterError.modelPackageMissing(bundleName)
        }
        guard let backend else {
            throw KokoroAdapterError.backendNotLinked
        }
        let samples = try await backend.synthesize24kHzPCM(
            modelURL: url,
            voiceName: voiceName,
            text: text,
            speed: speed
        )
        return PiperONNXAdapter.encodeWavRIFF(samples: samples, sampleRate: 24_000)
    }
}
