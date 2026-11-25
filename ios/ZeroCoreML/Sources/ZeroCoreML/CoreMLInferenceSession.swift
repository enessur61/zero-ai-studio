import Foundation
import CoreML

/// Owns every non-Sendable Core ML object used by Llama inference.
/// All model and state access is actor-isolated; prediction is deliberately
/// synchronous so the actor cannot be re-entered while Core ML is using MLModel/MLState.
actor CoreMLInferenceSession {
    private let variant: Llama32Variant
    private let computeUnits: MLComputeUnits
    private let modelURL: URL?
    private var model: MLModel?
    private var states: [UUID: MLState] = [:]

    init(
        variant: Llama32Variant,
        computeUnits: MLComputeUnits,
        modelURL: URL? = nil
    ) {
        self.variant = variant
        self.computeUnits = computeUnits
        self.modelURL = modelURL
    }

    func loadModelIfNeeded() throws {
        guard model == nil else { return }
        let resolvedURL: URL?
        if let modelURL {
            resolvedURL = modelURL
        } else {
            let baseName = variant.bundleModelFilename.replacingOccurrences(of: ".mlmodelc", with: "")
            if let bundled = Bundle.main.url(forResource: baseName, withExtension: "mlmodelc") {
                resolvedURL = bundled
            } else if let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
                let candidate = documents
                    .appendingPathComponent("ZeroModels", isDirectory: true)
                    .appendingPathComponent(variant.bundleModelFilename, isDirectory: true)
                resolvedURL = FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
            } else {
                resolvedURL = nil
            }
        }
        guard let resolvedURL,
              FileManager.default.fileExists(atPath: resolvedURL.path) else {
            throw CoreMLAdapterError.modelBundleMissing(variant.bundleModelFilename)
        }

        let configuration = MLModelConfiguration()
        configuration.computeUnits = computeUnits
        configuration.allowLowPrecisionAccumulationOnGPU = true
        model = try MLModel(contentsOf: resolvedURL, configuration: configuration)
    }

    func makeState() throws -> UUID {
        guard let model else {
            throw CoreMLAdapterError.modelBundleMissing(variant.bundleModelFilename)
        }
        let identifier = UUID()
        states[identifier] = model.makeState()
        return identifier
    }

    func predictStep(
        inputIds: [Int32],
        startPosition: Int,
        stateID: UUID
    ) throws -> [Float] {
        guard let model, let state = states[stateID] else {
            throw CoreMLAdapterError.invalidInputTensor("Unbekannter oder freigegebener KV-Cache-State.")
        }
        guard !inputIds.isEmpty, startPosition >= 0 else {
            throw CoreMLAdapterError.invalidInputTensor("Leere Tokenfolge oder negative Cache-Position.")
        }

        let sequenceLength = inputIds.count
        let idsArray = try MLMultiArray(shape: [1, NSNumber(value: sequenceLength)], dataType: .int32)
        for (index, token) in inputIds.enumerated() {
            idsArray[[0, NSNumber(value: index)]] = NSNumber(value: token)
        }

        let totalColumns = startPosition + sequenceLength
        let maskArray = try MLMultiArray(
            shape: [1, 1, NSNumber(value: sequenceLength), NSNumber(value: totalColumns)],
            dataType: .float16
        )
        for row in 0..<sequenceLength {
            for column in 0..<totalColumns {
                let allowed = column <= startPosition + row
                maskArray[[0, 0, NSNumber(value: row), NSNumber(value: column)]] =
                    NSNumber(value: allowed ? 0.0 : -65504.0)
            }
        }

        let provider = try MLDictionaryFeatureProvider(dictionary: [
            "inputIds": MLFeatureValue(multiArray: idsArray),
            "causalMask": MLFeatureValue(multiArray: maskArray)
        ])

        // Synchronous stateful prediction is intentional: no actor suspension
        // can interleave another call against this model or state.
        let output = try model.prediction(from: provider, using: state)
        guard let logits = output.featureValue(for: "logits")?.multiArrayValue else {
            throw CoreMLAdapterError.missingOutputLogits
        }

        return Self.copyLogits(logits)
    }

    static func copyLogits(_ logits: MLMultiArray) -> [Float] {
        var values: [Float] = []
        values.reserveCapacity(logits.count)
        for index in 0..<logits.count {
            values.append(logits[index].floatValue)
        }
        return values
    }

    func releaseState(_ identifier: UUID) {
        states.removeValue(forKey: identifier)
    }

    func unloadModel() {
        states.removeAll()
        model = nil
    }

    func activeStateCount() -> Int {
        states.count
    }

    func cancellationCheckpoint() throws {
        try Task.checkCancellation()
    }
}
