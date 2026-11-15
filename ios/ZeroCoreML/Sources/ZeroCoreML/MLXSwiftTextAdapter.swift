import Foundation
import CoreML

public enum MLXTextVariant: String, Codable, Sendable, CaseIterable {
    case qwen25_3B = "qwen-2.5-3b-coreml"
    case deepseekR1_15B = "deepseek-r1-distill-1.5b"

    public var displayName: String {
        switch self {
        case .qwen25_3B:
            return "Qwen 2.5 3B Instruct (4-bit MLX / CoreML)"
        case .deepseekR1_15B:
            return "DeepSeek-R1-Distill-Qwen-1.5B (4-bit MLX)"
        }
    }

    public var repoId: String {
        switch self {
        case .qwen25_3B:
            return "mlx-community/Qwen2.5-3B-Instruct-4bit"
        case .deepseekR1_15B:
            return "mlx-community/DeepSeek-R1-Distill-Qwen-1.5B-4bit"
        }
    }

    public var localFolderName: String {
        switch self {
        case .qwen25_3B: return "Qwen2.5-3B-Instruct-4bit"
        case .deepseekR1_15B: return "DeepSeek-R1-Distill-Qwen-1.5B-4bit"
        }
    }

    public var estimatedModelSizeGB: Double {
        switch self {
        case .qwen25_3B: return 1.90
        case .deepseekR1_15B: return 1.10
        }
    }

    public var estimatedPeakRAMGB: Double {
        switch self {
        case .qwen25_3B: return 3.40
        case .deepseekR1_15B: return 2.10
        }
    }

    public var eosTokens: Set<String> {
        ["<|im_end|>", "<|endoftext|>", "<｜end▁of▁sentence｜>"]
    }
}

public protocol MLXInferenceBackend: Sendable {
    func streamGenerate(
        modelDirectory: URL,
        formattedPrompt: String,
        maxTokens: Int,
        temperature: Float,
        topP: Float,
        onToken: @Sendable (String) -> Void
    ) async throws -> String
}

public struct MLXDeploymentDiagnostics: Codable, Sendable {
    public let modelId: String
    public let status: String
    public let runtime: String
    public let deviceModel: String
    public let weightsPresent: Bool
    public let estimatedRamGB: Double
}

public enum MLXTextAdapterError: Error, LocalizedError, Sendable {
    case weightsMissing(folder: String, huggingFaceRepo: String)
    case backendNotLinked(String)
    case insufficientMemory(requiredGB: Double, availableGB: Double)

    public var errorDescription: String? {
        switch self {
        case .weightsMissing(let folder, let repo):
            return "MLX-Gewichte '\(folder)' fehlen im Documents/ZeroModels Verzeichnis (Quelle: \(repo))."
        case .backendNotLinked(let model):
            return "Apple MLXLLM Swift-Paket nicht im Xcode-Target verknüpft für \(model)."
        case .insufficientMemory(let req, let avail):
            return String(format: "Nicht genügend Unified RAM: %.2f GB benötigt, %.2f GB verfügbar.", req, avail)
        }
    }
}

/// Apple MLX Swift Runtime Adapter für Qwen 2.5 3B Instruct & DeepSeek-R1-Distill-Qwen-1.5B
/// Optimiert für Apple A18 Pro GPU + Unified Memory auf iPhone 16 Pro Max (8 GB RAM).
public final class MLXSwiftTextAdapter: @unchecked Sendable {
    public let variant: MLXTextVariant
    public let systemPrompt: String
    public let maxTokens: Int
    public let temperature: Float
    public let topP: Float
    private let backend: MLXInferenceBackend?

    public init(
        variant: MLXTextVariant,
        systemPrompt: String = "Du bist ZERO CORE auf dem iPhone 16 Pro Max. Antworte sachlich auf Deutsch. Striktes Budget: 0 €.",
        maxTokens: Int = 768,
        temperature: Float = 0.6,
        topP: Float = 0.9,
        backend: MLXInferenceBackend? = nil
    ) {
        self.variant = variant
        self.systemPrompt = systemPrompt
        self.maxTokens = maxTokens
        self.temperature = temperature
        self.topP = topP
        self.backend = backend
    }

    public static func locateModelDirectory(
        for variant: MLXTextVariant,
        bundle: Bundle = .main,
        documentsDirectory: URL? = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    ) -> URL? {
        if let bundled = bundle.url(forResource: variant.localFolderName, withExtension: nil) {
            return bundled
        }
        if let docs = documentsDirectory {
            let candidate = docs
                .appendingPathComponent("ZeroModels", isDirectory: true)
                .appendingPathComponent(variant.localFolderName, isDirectory: true)
            let configFile = candidate.appendingPathComponent("config.json")
            if FileManager.default.fileExists(atPath: configFile.path) {
                return candidate
            }
        }
        return nil
    }

    public func formatChatMLPrompt(userPrompt: String) -> String {
        switch variant {
        case .qwen25_3B:
            return """
            <|im_start|>system
            \(systemPrompt)<|im_end|>
            <|im_start|>user
            \(userPrompt)<|im_end|>
            <|im_start|>assistant
            """
        case .deepseekR1_15B:
            return """
            <｜begin▁of▁sentence｜>\(systemPrompt)
            <｜User｜>\(userPrompt)<｜Assistant｜><think>
            """
        }
    }

    /// Trennt DeepSeek-R1 `<think>...</think>` Denkschritte von der finalen Antwort.
    public static func extractReasoningAndAnswer(_ rawOutput: String) -> (reasoning: String?, answer: String) {
        guard let endRange = rawOutput.range(of: "</think>") else {
            return (nil, rawOutput.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        let thought = String(rawOutput[..<endRange.lowerBound])
            .replacingOccurrences(of: "<think>", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let answer = String(rawOutput[endRange.upperBound...])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (thought.isEmpty ? nil : thought, answer)
    }

    public func deploymentDiagnostics() -> MLXDeploymentDiagnostics {
        let dir = Self.locateModelDirectory(for: variant)
        return MLXDeploymentDiagnostics(
            modelId: variant.rawValue,
            status: "NATIVE APP INTEGRATION ERFORDERLICH",
            runtime: "Apple MLX Swift (Metal GPU Unified Memory · 4-bit Q4)",
            deviceModel: "iPhone 16 Pro Max (8 GB Unified RAM)",
            weightsPresent: dir != nil,
            estimatedRamGB: variant.estimatedPeakRAMGB
        )
    }

    public func generate(
        prompt: String,
        onToken: (@Sendable (String) -> Void)? = nil
    ) async throws -> String {
        let totalRamGB = Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824.0
        if totalRamGB > 0 && totalRamGB < variant.estimatedPeakRAMGB {
            throw MLXTextAdapterError.insufficientMemory(
                requiredGB: variant.estimatedPeakRAMGB,
                availableGB: totalRamGB
            )
        }
        guard let dir = Self.locateModelDirectory(for: variant) else {
            throw MLXTextAdapterError.weightsMissing(
                folder: variant.localFolderName,
                huggingFaceRepo: variant.repoId
            )
        }
        guard let backend else {
            throw MLXTextAdapterError.backendNotLinked(variant.displayName)
        }

        let formatted = formatChatMLPrompt(userPrompt: prompt)
        let raw = try await backend.streamGenerate(
            modelDirectory: dir,
            formattedPrompt: formatted,
            maxTokens: maxTokens,
            temperature: temperature,
            topP: topP
        ) { piece in
            onToken?(piece)
        }

        if variant == .deepseekR1_15B {
            return Self.extractReasoningAndAnswer(raw).answer
        }
        return raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
