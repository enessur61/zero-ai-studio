import Foundation
import CoreML

public protocol LlamaTokenizer: Sendable {
    func encode(_ text: String) -> [Int32]
    func decode(_ tokenIds: [Int32]) -> String
}

public enum CoreMLAdapterError: Error, LocalizedError, Sendable {
    case modelBundleMissing(String)
    case insufficientDeviceMemory(requiredGB: Double, availableGB: Double)
    case invalidInputTensor(String)
    case missingOutputLogits

    public var errorDescription: String? {
        switch self {
        case .modelBundleMissing(let name):
            return "Kompiliertes CoreML-Modellpaket '\(name)' nicht im App-Bundle gefunden."
        case .insufficientDeviceMemory(let req, let avail):
            return String(format: "Nicht genügend RAM: %.2f GB benötigt, %.2f GB verfügbar.", req, avail)
        case .invalidInputTensor(let detail):
            return "Ungültiger CoreML Input-Tensor: \(detail)"
        case .missingOutputLogits:
            return "CoreML-Modell hat keine 'logits' Ausgabe zurückgegeben."
        }
    }
}

public struct CoreMLDeploymentStatus: Codable, Sendable {
    public let modelId: String
    public let status: String
    public let runtime: String
    public let deviceModel: String
    public let neuralEngineTargeted: Bool
    public let compiledModelPresent: Bool
    public let estimatedRamGB: Double
}

/// Main-actor facade. Non-Sendable Core ML objects are owned exclusively by
/// CoreMLInferenceSession and never escape that actor.
@MainActor
public final class LlamaCoreMLAdapter {
    private let config: LlamaCoreMLConfig
    private let tokenizer: LlamaTokenizer?
    private let inferenceSession: CoreMLInferenceSession

    public init(config: LlamaCoreMLConfig = .init(), tokenizer: LlamaTokenizer? = nil) {
        self.config = config
        self.tokenizer = tokenizer
        self.inferenceSession = CoreMLInferenceSession(
            variant: config.variant,
            computeUnits: config.computeUnits
        )
    }

    public static func locateCompiledModelURL(
        for variant: Llama32Variant,
        bundle: Bundle = .main,
        documentsDirectory: URL? = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    ) -> URL? {
        let baseName = variant.bundleModelFilename.replacingOccurrences(of: ".mlmodelc", with: "")
        if let bundled = bundle.url(forResource: baseName, withExtension: "mlmodelc") {
            return bundled
        }
        if let docs = documentsDirectory {
            let candidate = docs
                .appendingPathComponent("ZeroModels", isDirectory: true)
                .appendingPathComponent(variant.bundleModelFilename, isDirectory: true)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }

    public func deploymentDiagnostics() -> CoreMLDeploymentStatus {
        let modelURL = Self.locateCompiledModelURL(for: config.variant)
        return CoreMLDeploymentStatus(
            modelId: config.variant.rawValue,
            status: "NATIVE APP INTEGRATION ERFORDERLICH",
            runtime: "Apple CoreML (MLModel + MLState · A18 Pro Neural Engine)",
            deviceModel: "iPhone 16 Pro Max (8 GB Unified RAM)",
            neuralEngineTargeted: config.computeUnits == .cpuAndNeuralEngine || config.computeUnits == .all,
            compiledModelPresent: modelURL != nil,
            estimatedRamGB: config.variant.estimatedPeakRAMGB
        )
    }

    public func loadModelIfNeeded() async throws {
        let totalRamGB = Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824.0
        if totalRamGB > 0 && totalRamGB < config.variant.estimatedPeakRAMGB {
            throw CoreMLAdapterError.insufficientDeviceMemory(
                requiredGB: config.variant.estimatedPeakRAMGB,
                availableGB: totalRamGB
            )
        }
        try await inferenceSession.loadModelIfNeeded()
    }

    public func unloadModel() async {
        await inferenceSession.unloadModel()
    }

    /// Autoregressive next-token sampling. Model and KV-cache state remain actor-owned.
    public func generate(
        prompt: String,
        onToken: (@Sendable (String) -> Void)? = nil
    ) async throws -> String {
        try await loadModelIfNeeded()
        guard let tokenizer else {
            throw CoreMLAdapterError.invalidInputTensor("Tokenizer-Implementierung nicht initialisiert.")
        }

        let formatted = config.formatLlama32Prompt(userPrompt: prompt)
        var promptTokens = tokenizer.encode(formatted)
        if promptTokens.count > config.variant.contextLength - 64 {
            promptTokens = Array(promptTokens.suffix(config.variant.contextLength - 64))
        }
        guard !promptTokens.isEmpty else {
            throw CoreMLAdapterError.invalidInputTensor("Tokenizer lieferte keine Prompt-Tokens.")
        }

        let stateID = try await inferenceSession.makeState()
        do {
            var generatedIds: [Int32] = []
            var nextLogits = try await inferenceSession.predictStep(
                inputIds: promptTokens,
                startPosition: 0,
                stateID: stateID
            )

            var cursor = promptTokens.count
            for _ in 0..<config.maxNewTokens {
                try Task.checkCancellation()
                let nextID = sampleTopP(
                    logits: nextLogits,
                    temperature: config.temperature,
                    topP: config.topP
                )
                if config.variant.eosTokenIds.contains(nextID) { break }

                generatedIds.append(nextID)
                onToken?(tokenizer.decode([nextID]))
                if cursor >= config.variant.contextLength - 1 { break }

                try Task.checkCancellation()
                nextLogits = try await inferenceSession.predictStep(
                    inputIds: [nextID],
                    startPosition: cursor,
                    stateID: stateID
                )
                cursor += 1
            }

            await inferenceSession.releaseState(stateID)
            return tokenizer.decode(generatedIds).trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            await inferenceSession.releaseState(stateID)
            throw error
        }
    }

    private func sampleTopP(logits: [Float], temperature: Float, topP: Float) -> Int32 {
        let count = min(config.variant.vocabSize, logits.count)
        let offset = max(0, logits.count - config.variant.vocabSize)
        guard count > 0 else { return 0 }

        if temperature <= 0.05 {
            var bestIndex = 0
            var bestValue: Float = -.greatestFiniteMagnitude
            for index in 0..<count {
                let value = logits[offset + index]
                if value > bestValue {
                    bestValue = value
                    bestIndex = index
                }
            }
            return Int32(bestIndex)
        }

        var candidates: [(index: Int, weight: Float)] = []
        candidates.reserveCapacity(count)
        var maxLogit: Float = -.greatestFiniteMagnitude
        for index in 0..<count {
            maxLogit = max(maxLogit, logits[offset + index] / temperature)
        }

        var sumExp: Float = 0
        for index in 0..<count {
            let weight = expf(logits[offset + index] / temperature - maxLogit)
            sumExp += weight
            candidates.append((index, weight))
        }
        candidates.sort { $0.weight > $1.weight }

        var cumulative: Float = 0
        var cutoff = 0
        for (index, candidate) in candidates.enumerated() {
            cumulative += candidate.weight / max(sumExp, 1e-6)
            cutoff = index + 1
            if cumulative >= topP { break }
        }

        let nucleus = candidates.prefix(max(1, cutoff))
        let totalMass = nucleus.reduce(Float(0)) { $0 + $1.weight }
        let randomValue = Float.random(in: 0..<max(totalMass, 1e-6))
        var accumulated: Float = 0
        for candidate in nucleus {
            accumulated += candidate.weight
            if accumulated >= randomValue { return Int32(candidate.index) }
        }
        return Int32(nucleus.first?.index ?? 0)
    }
}
