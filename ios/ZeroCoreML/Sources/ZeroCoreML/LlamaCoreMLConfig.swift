import Foundation
import CoreML

public enum Llama32Variant: String, Codable, Sendable, CaseIterable {
    case instruct1B = "llama-3.2-1b-coreml"
    case instruct3B = "llama-3.2-3b-coreml"

    public var displayName: String {
        switch self {
        case .instruct1B:
            return "Llama 3.2 1B Instruct (4-bit LUT CoreML)"
        case .instruct3B:
            return "Llama 3.2 3B Instruct (4-bit LUT CoreML)"
        }
    }

    public var bundleModelFilename: String {
        switch self {
        case .instruct1B:
            return "Llama-3.2-1B-Instruct-4bit.mlmodelc"
        case .instruct3B:
            return "Llama-3.2-3B-Instruct-4bit.mlmodelc"
        }
    }

    public var estimatedModelSizeGB: Double {
        switch self {
        case .instruct1B: return 0.72
        case .instruct3B: return 1.85
        }
    }

    public var estimatedPeakRAMGB: Double {
        switch self {
        case .instruct1B: return 1.40
        case .instruct3B: return 3.40
        }
    }

    public var contextLength: Int { 4096 }
    public var vocabSize: Int { 128_256 }
    public var eosTokenIds: Set<Int32> { [128_001, 128_008, 128_009] }
}

public struct LlamaCoreMLConfig: Sendable {
    public let variant: Llama32Variant
    public let computeUnits: MLComputeUnits
    public let maxNewTokens: Int
    public let temperature: Float
    public let topP: Float
    public let systemPrompt: String

    public init(
        variant: Llama32Variant = .instruct3B,
        computeUnits: MLComputeUnits = .cpuAndNeuralEngine,
        maxNewTokens: Int = 512,
        temperature: Float = 0.6,
        topP: Float = 0.9,
        systemPrompt: String = "Du bist ZERO CORE auf dem iPhone 16 Pro Max. Antworte präzise auf Deutsch. Striktes Budget: 0 €."
    ) {
        self.variant = variant
        self.computeUnits = computeUnits
        self.maxNewTokens = maxNewTokens
        self.temperature = temperature
        self.topP = topP
        self.systemPrompt = systemPrompt
    }

    public func makeMLModelConfiguration() -> MLModelConfiguration {
        let cfg = MLModelConfiguration()
        cfg.computeUnits = computeUnits
        cfg.allowLowPrecisionAccumulationOnGPU = true
        return cfg
    }

    public func formatLlama32Prompt(userPrompt: String) -> String {
        """
        <|begin_of_text|><|start_header_id|>system<|end_header_id|>

        \(systemPrompt)<|eot_id|><|start_header_id|>user<|end_header_id|>

        \(userPrompt)<|eot_id|><|start_header_id|>assistant<|end_header_id|>

        """
    }
}
