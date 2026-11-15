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

/// Lokaler CoreML-Adapter für Meta Llama 3.2 (1B / 3B Instruct, 4-bit quantisiert)
/// Optimiert für Apple A18 Pro Neural Engine auf iPhone 16 Pro Max (8 GB Unified Memory).
public final class LlamaCoreMLAdapter: @unchecked Sendable {
    private let config: LlamaCoreMLConfig
    private let tokenizer: LlamaTokenizer?
    private var model: MLModel?

    public init(config: LlamaCoreMLConfig = .init(), tokenizer: LlamaTokenizer? = nil) {
        self.config = config
        self.tokenizer = tokenizer
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
            status: "Ready for Deployment",
            runtime: "Apple CoreML (MLModel + MLState · A18 Pro Neural Engine)",
            deviceModel: "iPhone 16 Pro Max (8 GB Unified RAM)",
            neuralEngineTargeted: config.computeUnits == .cpuAndNeuralEngine || config.computeUnits == .all,
            compiledModelPresent: modelURL != nil,
            estimatedRamGB: config.variant.estimatedPeakRAMGB
        )
    }

    public func loadModelIfNeeded() async throws {
        if model != nil { return }

        let totalRamGB = Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824.0
        if totalRamGB > 0 && totalRamGB < config.variant.estimatedPeakRAMGB {
            throw CoreMLAdapterError.insufficientDeviceMemory(
                requiredGB: config.variant.estimatedPeakRAMGB,
                availableGB: totalRamGB
            )
        }

        guard let modelURL = Self.locateCompiledModelURL(for: config.variant) else {
            throw CoreMLAdapterError.modelBundleMissing(config.variant.bundleModelFilename)
        }

        let mlConfig = config.makeMLModelConfiguration()
        self.model = try await MLModel.load(contentsOf: modelURL, configuration: mlConfig)
    }

    public func unloadModel() {
        self.model = nil
    }

    /// Führt autoregressives Next-Token-Sampling mit CoreML MLState KV-Cache aus.
    public func generate(
        prompt: String,
        onToken: (@Sendable (String) -> Void)? = nil
    ) async throws -> String {
        try await loadModelIfNeeded()
        guard let loadedModel = model else {
            throw CoreMLAdapterError.modelBundleMissing(config.variant.bundleModelFilename)
        }
        guard let tokenizer else {
            throw CoreMLAdapterError.invalidInputTensor("Tokenizer-Implementierung nicht initialisiert.")
        }

        let formatted = config.formatLlama32Prompt(userPrompt: prompt)
        var promptTokens = tokenizer.encode(formatted)
        if promptTokens.count > config.variant.contextLength - 64 {
            promptTokens = Array(promptTokens.suffix(config.variant.contextLength - 64))
        }

        let kvState = loadedModel.makeState()
        var generatedIds: [Int32] = []

        // 1. Prefill-Phase über alle Prompt-Tokens
        var nextLogits = try await predictStep(
            model: loadedModel,
            inputIds: promptTokens,
            startPosition: 0,
            state: kvState
        )

        // 2. Autoregressive Decode-Schleife
        var cursor = promptTokens.count
        for _ in 0..<config.maxNewTokens {
            try Task.checkCancellation()
            let nextId = sampleTopP(logits: nextLogits, temperature: config.temperature, topP: config.topP)
            if config.variant.eosTokenIds.contains(nextId) {
                break
            }
            generatedIds.append(nextId)
            let piece = tokenizer.decode([nextId])
            onToken?(piece)

            if cursor >= config.variant.contextLength - 1 {
                break
            }
            nextLogits = try await predictStep(
                model: loadedModel,
                inputIds: [nextId],
                startPosition: cursor,
                state: kvState
            )
            cursor += 1
        }

        return tokenizer.decode(generatedIds).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func predictStep(
        model: MLModel,
        inputIds: [Int32],
        startPosition: Int,
        state: MLState
    ) async throws -> MLMultiArray {
        let seqLen = inputIds.count
        let idsArray = try MLMultiArray(shape: [1, NSNumber(value: seqLen)], dataType: .int32)
        for (idx, tok) in inputIds.enumerated() {
            idsArray[[0, NSNumber(value: idx)]] = NSNumber(value: tok)
        }

        let maskArray = try MLMultiArray(
            shape: [1, 1, NSNumber(value: seqLen), NSNumber(value: startPosition + seqLen)],
            dataType: .float16
        )
        let totalCols = startPosition + seqLen
        for row in 0..<seqLen {
            for col in 0..<totalCols {
                let allowed = col <= (startPosition + row)
                maskArray[[0, 0, NSNumber(value: row), NSNumber(value: col)]] = NSNumber(value: allowed ? 0.0 : -65504.0)
            }
        }

        let provider = try MLDictionaryFeatureProvider(dictionary: [
            "inputIds": MLFeatureValue(multiArray: idsArray),
            "causalMask": MLFeatureValue(multiArray: maskArray)
        ])

        let output = try await model.prediction(from: provider, using: state)
        guard let logits = output.featureValue(for: "logits")?.multiArrayValue else {
            throw CoreMLAdapterError.missingOutputLogits
        }
        return logits
    }

    private func sampleTopP(logits: MLMultiArray, temperature: Float, topP: Float) -> Int32 {
        let vocabCount = config.variant.vocabSize
        let count = min(vocabCount, logits.count)
        let offset = max(0, logits.count - vocabCount)

        if temperature <= 0.05 {
            var bestIdx = 0
            var bestVal: Float = -.greatestFiniteMagnitude
            for i in 0..<count {
                let v = logits[offset + i].floatValue
                if v > bestVal {
                    bestVal = v
                    bestIdx = i
                }
            }
            return Int32(bestIdx)
        }

        var scaled = [(index: Int, prob: Float)]()
        scaled.reserveCapacity(count)
        var maxLogit: Float = -.greatestFiniteMagnitude
        for i in 0..<count {
            let v = logits[offset + i].floatValue / temperature
            if v > maxLogit { maxLogit = v }
        }

        var sumExp: Float = 0
        for i in 0..<count {
            let v = logits[offset + i].floatValue / temperature
            let e = expf(v - maxLogit)
            sumExp += e
            scaled.append((i, e))
        }

        scaled.sort { $0.prob > $1.prob }
        var cumulative: Float = 0
        var cutoff = 0
        for (idx, item) in scaled.enumerated() {
            cumulative += item.prob / max(sumExp, 1e-6)
            cutoff = idx + 1
            if cumulative >= topP { break }
        }

        let candidates = scaled.prefix(max(1, cutoff))
        let totalMass = candidates.reduce(Float(0)) { $0 + $1.prob }
        let r = Float.random(in: 0..<max(totalMass, 1e-6))
        var acc: Float = 0
        for item in candidates {
            acc += item.prob
            if acc >= r {
                return Int32(item.index)
            }
        }
        return Int32(candidates.first?.index ?? 0)
    }
}
