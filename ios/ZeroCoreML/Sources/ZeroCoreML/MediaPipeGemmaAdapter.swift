import Foundation
import CoreGraphics

public struct GemmaMediaPipeConfig: Sendable {
    public let modelId: String
    public let taskBundleFilename: String
    public let maxTokens: Int
    public let topK: Int
    public let temperature: Float
    public let enableVisionModality: Bool
    public let estimatedModelSizeGB: Double
    public let estimatedPeakRAMGB: Double

    public init(
        modelId: String = "gemma-3-4b-it",
        taskBundleFilename: String = "gemma3-4b-it-int4.task",
        maxTokens: Int = 2048,
        topK: Int = 40,
        temperature: Float = 0.7,
        enableVisionModality: Bool = true,
        estimatedModelSizeGB: Double = 2.60,
        estimatedPeakRAMGB: Double = 4.50
    ) {
        self.modelId = modelId
        self.taskBundleFilename = taskBundleFilename
        self.maxTokens = maxTokens
        self.topK = topK
        self.temperature = temperature
        self.enableVisionModality = enableVisionModality
        self.estimatedModelSizeGB = estimatedModelSizeGB
        self.estimatedPeakRAMGB = estimatedPeakRAMGB
    }
}

public protocol MediaPipeLlmSessionBackend: Sendable {
    func generateResponse(
        modelTaskURL: URL,
        formattedPrompt: String,
        image: CGImage?,
        maxTokens: Int,
        topK: Int,
        temperature: Float,
        onPartialToken: @Sendable (String) -> Void
    ) async throws -> String
}

public enum MediaPipeGemmaError: Error, LocalizedError, Sendable {
    case taskBundleMissing(String)
    case insufficientMemory(requiredGB: Double, availableGB: Double)
    case mediapipeFrameworkMissing

    public var errorDescription: String? {
        switch self {
        case .taskBundleMissing(let file):
            return "MediaPipe Task-Bundle '\(file)' fehlt in Bundle oder Documents/ZeroModels."
        case .insufficientMemory(let req, let avail):
            return String(format: "Gemma 3 4B benötigt %.2f GB RAM, verfügbar: %.2f GB.", req, avail)
        case .mediapipeFrameworkMissing:
            return "MediaPipeTasksGenAI iOS Framework muss im Xcode-Target verlinkt sein."
        }
    }
}

public struct GemmaDeploymentDiagnostics: Codable, Sendable {
    public let modelId: String
    public let status: String
    public let runtime: String
    public let deviceModel: String
    public let supportsVision: Bool
    public let taskBundlePresent: Bool
    public let estimatedRamGB: Double
}

/// MediaPipe Tasks GenAI Adapter für Google Gemma 3 4B IT (4-bit Quantized Multimodal) auf iPhone 16 Pro Max.
public final class MediaPipeGemmaAdapter: @unchecked Sendable {
    public let config: GemmaMediaPipeConfig
    private let backend: MediaPipeLlmSessionBackend?

    public init(config: GemmaMediaPipeConfig = .init(), backend: MediaPipeLlmSessionBackend? = nil) {
        self.config = config
        self.backend = backend
    }

    public static func locateTaskBundleURL(
        filename: String,
        bundle: Bundle = .main,
        documentsDirectory: URL? = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    ) -> URL? {
        let base = filename.replacingOccurrences(of: ".task", with: "")
        if let bundled = bundle.url(forResource: base, withExtension: "task") {
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

    public func formatGemma3Turn(userPrompt: String, systemPrompt: String = "Du bist ZERO CORE (0 € Offline-Assistent auf iPhone 16 Pro Max). Antworte auf Deutsch.") -> String {
        """
        <start_of_turn>user
        \(systemPrompt)

        \(userPrompt)<end_of_turn>
        <start_of_turn>model
        """
    }

    public func deploymentDiagnostics() -> GemmaDeploymentDiagnostics {
        let url = Self.locateTaskBundleURL(filename: config.taskBundleFilename)
        return GemmaDeploymentDiagnostics(
            modelId: config.modelId,
            status: "NATIVE APP INTEGRATION ERFORDERLICH",
            runtime: "MediaPipe Tasks GenAI iOS (Metal GPU · 4-bit Multimodal)",
            deviceModel: "iPhone 16 Pro Max (8 GB Unified RAM)",
            supportsVision: config.enableVisionModality,
            taskBundlePresent: url != nil,
            estimatedRamGB: config.estimatedPeakRAMGB
        )
    }

    public func generate(
        prompt: String,
        image: CGImage? = nil,
        onToken: (@Sendable (String) -> Void)? = nil
    ) async throws -> String {
        let totalRamGB = Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824.0
        if totalRamGB > 0 && totalRamGB < config.estimatedPeakRAMGB {
            throw MediaPipeGemmaError.insufficientMemory(
                requiredGB: config.estimatedPeakRAMGB,
                availableGB: totalRamGB
            )
        }
        guard let url = Self.locateTaskBundleURL(filename: config.taskBundleFilename) else {
            throw MediaPipeGemmaError.taskBundleMissing(config.taskBundleFilename)
        }
        guard let backend else {
            throw MediaPipeGemmaError.mediapipeFrameworkMissing
        }

        let formatted = formatGemma3Turn(userPrompt: prompt)
        return try await backend.generateResponse(
            modelTaskURL: url,
            formattedPrompt: formatted,
            image: image,
            maxTokens: config.maxTokens,
            topK: config.topK,
            temperature: config.temperature
        ) { piece in
            onToken?(piece)
        }
    }
}
