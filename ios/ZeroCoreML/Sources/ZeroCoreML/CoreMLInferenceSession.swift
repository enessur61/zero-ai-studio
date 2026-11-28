import Foundation
import CoreML

/// Owns every non-Sendable Core ML object used by Llama inference.
/// All model and state access is actor-isolated; prediction is deliberately
/// synchronous so the actor cannot be re-entered while Core ML is using MLModel/MLState.
actor CoreMLInferenceSession {
    private let variant: Llama32Variant
    private let computeUnits: MLComputeUnits
    private let modelURL: URL?
    private let permitsSyntheticFixture: Bool
    private var model: MLModel?
    private var runtimeSnapshotRoot: URL?
    private var states: [UUID: MLState] = [:]

    init(
        variant: Llama32Variant,
        computeUnits: MLComputeUnits,
        modelURL: URL? = nil,
        permitsSyntheticFixture: Bool = false
    ) {
        self.variant = variant
        self.computeUnits = computeUnits
        self.modelURL = modelURL
        self.permitsSyntheticFixture = permitsSyntheticFixture
    }

    func loadModelIfNeeded() throws {
        guard model == nil else { return }
        // The tiny accumulator fixture is deliberately opt-in and test-only.
        // Real Llama packages remain blocked until their own artifact-bound
        // tensor contract has been extracted and reviewed.
        let resolvedURL: URL?
        var isInstalledArtifact = false
        if let modelURL {
            resolvedURL = modelURL
            isInstalledArtifact = modelURL.lastPathComponent == "model.mlmodelc"
        } else {
            let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
                ?? FileManager.default.temporaryDirectory
            let envelope = documents.appendingPathComponent("ZeroModels", isDirectory: true)
                .appendingPathComponent(CoreMLArtifactImportStore.installationDirectoryName(for: variant), isDirectory: true)
            let installed = envelope.appendingPathComponent("model.mlmodelc", isDirectory: true)
            isInstalledArtifact = FileManager.default.fileExists(atPath: installed.path)
            resolvedURL = isInstalledArtifact ? installed : nil
        }
        guard let resolvedURL,
              FileManager.default.fileExists(atPath: resolvedURL.path) else {
            // Preserve the more fundamental production gate when no artifact is
            // present; absence of weights must never look like a model-ready state.
            if !permitsSyntheticFixture {
                try LlamaCoreMLModelContract.requireProductionEvidence(for: variant)
            }
            throw CoreMLAdapterError.modelBundleMissing(variant.bundleModelFilename)
        }

        if !permitsSyntheticFixture && !isInstalledArtifact {
            throw CoreMLAdapterError.modelContractUnverified(
                variant.rawValue,
                "Produktive Modelle dürfen ausschließlich aus dem festgelegten, signaturgeprüften Installations-Trust-Root geladen werden."
            )
        }
        var modelURLToLoad = resolvedURL
        if isInstalledArtifact && !permitsSyntheticFixture {
            do {
                let snapshot = try makeVerifiedRuntimeSnapshot(from: resolvedURL)
                modelURLToLoad = snapshot.packageURL
                runtimeSnapshotRoot = snapshot.rootURL
            } catch {
                throw CoreMLAdapterError.modelContractUnverified(
                    variant.rawValue,
                    "Installiertes Artefakt konnte nicht in einen isolierten, erneut verifizierten Runtime-Snapshot übernommen werden: \(error.localizedDescription)"
                )
            }
        }
        if !permitsSyntheticFixture {
            try LlamaCoreMLModelContract.requireProductionEvidence(for: variant)
        }

        let configuration = MLModelConfiguration()
        configuration.computeUnits = computeUnits
        configuration.allowLowPrecisionAccumulationOnGPU = true
        do {
            model = try MLModel(contentsOf: modelURLToLoad, configuration: configuration)
        } catch {
            if let runtimeSnapshotRoot {
                try? FileManager.default.removeItem(at: runtimeSnapshotRoot)
                self.runtimeSnapshotRoot = nil
            }
            throw error
        }
    }

    private func makeVerifiedRuntimeSnapshot(from installedPackageURL: URL) throws -> (rootURL: URL, packageURL: URL) {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let installRoot = documents.appendingPathComponent("ZeroModels", isDirectory: true)
        let trust = CoreMLArtifactTrust.pinnedPublicKey()
        let sourceVerifier = CoreMLArtifactImportStore(trustedPublicKey: trust, installRoot: installRoot)
        try sourceVerifier.verifyInstalledPackage(at: installedPackageURL, for: variant)

        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let runtimeBase = caches.appendingPathComponent("ZeroCoreMLRuntime", isDirectory: true)
        try FileManager.default.createDirectory(at: runtimeBase, withIntermediateDirectories: true)
        let snapshotRoot = runtimeBase.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let snapshotEnvelope = snapshotRoot.appendingPathComponent(
            CoreMLArtifactImportStore.installationDirectoryName(for: variant),
            isDirectory: true
        )
        do {
            try FileManager.default.createDirectory(at: snapshotRoot, withIntermediateDirectories: false)
            try FileManager.default.copyItem(
                at: installedPackageURL.deletingLastPathComponent(),
                to: snapshotEnvelope
            )
            let snapshotVerifier = CoreMLArtifactImportStore(
                trustedPublicKey: trust,
                installRoot: snapshotRoot
            )
            let snapshotPackage = snapshotEnvelope.appendingPathComponent("model.mlmodelc", isDirectory: true)
            try snapshotVerifier.verifyInstalledPackage(at: snapshotPackage, for: variant)
            return (snapshotRoot, snapshotPackage)
        } catch {
            try? FileManager.default.removeItem(at: snapshotRoot)
            throw error
        }
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
        guard !inputIds.isEmpty else {
            throw CoreMLAdapterError.invalidInputTensor("Leere Tokenfolge.")
        }

        let maskArray = try Self.makeCausalMask(
            sequenceLength: inputIds.count,
            startPosition: startPosition,
            contextLimit: variant.contextLength
        )
        let idsArray = try MLMultiArray(
            shape: [1, NSNumber(value: inputIds.count)],
            dataType: .int32
        )
        for (index, token) in inputIds.enumerated() {
            idsArray[[0, NSNumber(value: index)]] = NSNumber(value: token)
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

    /// Current 4-D additive mask builder. This layout and fp16 convention are
    /// validated only against the synthetic fixture, not a production Llama artifact.
    static func makeCausalMask(
        sequenceLength: Int,
        startPosition: Int,
        contextLimit: Int
    ) throws -> MLMultiArray {
        let (totalColumns, overflow) = startPosition.addingReportingOverflow(sequenceLength)
        guard sequenceLength > 0,
              startPosition >= 0,
              contextLimit > 0,
              !overflow,
              totalColumns <= contextLimit else {
            throw CoreMLAdapterError.invalidInputTensor("Sequenzfenster überschreitet das konfigurierte Kontextlimit.")
        }

        let mask = try MLMultiArray(
            shape: [1, 1, NSNumber(value: sequenceLength), NSNumber(value: totalColumns)],
            dataType: .float16
        )
        for row in 0..<sequenceLength {
            for column in 0..<totalColumns {
                let allowed = column <= startPosition + row
                mask[[0, 0, NSNumber(value: row), NSNumber(value: column)]] =
                    NSNumber(value: allowed ? 0.0 : -65504.0)
            }
        }
        return mask
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
        if let runtimeSnapshotRoot {
            try? FileManager.default.removeItem(at: runtimeSnapshotRoot)
            self.runtimeSnapshotRoot = nil
        }
    }

    func activeStateCount() -> Int {
        states.count
    }

    func cancellationCheckpoint() throws {
        try Task.checkCancellation()
    }
}
