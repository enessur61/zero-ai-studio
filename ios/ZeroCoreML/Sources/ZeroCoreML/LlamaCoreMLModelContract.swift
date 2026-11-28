import Foundation

/// Versioned evidence record for production Llama Core ML artifacts.
/// Empty artifact digests and absent tensor specs are intentional: no genuine
/// 1B/3B .mlmodelc package is present in this repository to establish them.
enum LlamaCoreMLModelContract {
    static let schemaVersion = 1

    struct Evidence {
        let variant: Llama32Variant
        let artifactSHA256: String?
        let inputTensorSpecifications: [String]?
        let outputTensorSpecifications: [String]?
        let stateTensorSpecifications: [String]?
        let attentionMaskSpecification: String?
        let isProductionReady: Bool
    }

    static func evidence(for variant: Llama32Variant) -> Evidence {
        Evidence(
            variant: variant,
            artifactSHA256: nil,
            inputTensorSpecifications: nil,
            outputTensorSpecifications: nil,
            stateTensorSpecifications: nil,
            attentionMaskSpecification: nil,
            isProductionReady: false
        )
    }

    static func requireProductionEvidence(for variant: Llama32Variant) throws {
        let record = evidence(for: variant)
        guard record.isProductionReady,
              let digest = record.artifactSHA256,
              digest.count == 64,
              record.inputTensorSpecifications != nil,
              record.outputTensorSpecifications != nil,
              record.stateTensorSpecifications != nil,
              record.attentionMaskSpecification != nil else {
            throw CoreMLAdapterError.modelContractUnverified(
                variant.rawValue,
                "Vertragsversion \(schemaVersion): echtes Modellartefakt, SHA-256 sowie Input-, Output-, State- und Maskenspezifikationen fehlen."
            )
        }
    }
}
