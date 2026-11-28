import Foundation

/// Reads the Ed25519 verification key pinned into the signed app bundle.
/// An absent, empty, malformed, or non-32-byte value disables model imports.
public enum CoreMLArtifactTrust {
    public static let infoPlistKey = "ZERO_COREML_ED25519_PUBLIC_KEY_BASE64"

    public static func pinnedPublicKey(bundle: Bundle = .main) -> Data? {
        guard let encoded = bundle.object(forInfoDictionaryKey: infoPlistKey) as? String else { return nil }
        return decodePinnedPublicKey(encoded)
    }

    public static func decodePinnedPublicKey(_ encoded: String) -> Data? {
        guard !encoded.isEmpty,
              encoded == encoded.trimmingCharacters(in: .whitespacesAndNewlines),
              let data = Data(base64Encoded: encoded, options: []),
              data.count == 32,
              data.base64EncodedString() == encoded else { return nil }
        return data
    }
}
