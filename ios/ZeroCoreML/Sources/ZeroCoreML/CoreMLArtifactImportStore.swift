import Foundation
import CryptoKit

public struct CoreMLArtifactManifest: Codable, Sendable {
    public struct FileRecord: Codable, Sendable {
        public let path: String
        public let size: UInt64
        public let sha256: String

        public init(path: String, size: UInt64, sha256: String) {
            self.path = path
            self.size = size
            self.sha256 = sha256
        }
    }

    public let schemaVersion: Int
    public let modelVariant: String
    public let packageSHA256: String
    public let files: [FileRecord]

    public init(schemaVersion: Int = 1, modelVariant: String, packageSHA256: String, files: [FileRecord]) {
        self.schemaVersion = schemaVersion
        self.modelVariant = modelVariant
        self.packageSHA256 = packageSHA256
        self.files = files
    }
}

/// Imports a compiled Core ML package only after detached Ed25519 signature,
/// complete file inventory, per-file SHA-256, and deterministic package digest
/// verification. The signing public key must be provisioned by the app owner;
/// there is deliberately no built-in development or fallback key.
public final class CoreMLArtifactImportStore: @unchecked Sendable {
    public enum ImportError: Error, LocalizedError, Sendable {
        case trustedKeyMissing
        case invalidPublicKey
        case invalidSignature
        case invalidManifest(String)
        case invalidPackage(String)
        case sizeLimitExceeded
        case destinationAlreadyExists
        case filesystem(String)

        public var errorDescription: String? {
            switch self {
            case .trustedKeyMissing: return "Kein vertrauenswürdiger Signaturschlüssel konfiguriert; Modellimport gesperrt."
            case .invalidPublicKey: return "Der konfigurierte Ed25519-Vertrauensschlüssel ist ungültig."
            case .invalidSignature: return "Die Manifest-Signatur ist ungültig."
            case .invalidManifest(let detail): return "Ungültiges Core-ML-Manifest: \(detail)"
            case .invalidPackage(let detail): return "Ungültiges Core-ML-Paket: \(detail)"
            case .sizeLimitExceeded: return "Das Core-ML-Paket überschreitet die Importlimits."
            case .destinationAlreadyExists: return "Am Installationsziel liegt bereits ein Paket; Überschreiben ist gesperrt."
            case .filesystem(let detail): return "Core-ML-Import fehlgeschlagen: \(detail)"
            }
        }
    }

    public static let maximumManifestBytes = 2 * 1024 * 1024
    public static let maximumFileCount = 100_000
    public static let maximumPackageEntries = 200_000
    public static let maximumFileBytes: UInt64 = 4 * 1024 * 1024 * 1024
    public static let maximumPackageBytes: UInt64 = 8 * 1024 * 1024 * 1024
    public static let maximumRelativePathBytes = 1_024

    private let fileManager: FileManager
    private let installRoot: URL
    private let trustedPublicKey: Data?

    /// Pass the raw 32-byte Curve25519.Signing public key from trusted app
    /// configuration. Passing nil intentionally disables all imports.
    public init(trustedPublicKey: Data?, installRoot: URL? = nil, fileManager: FileManager = .default) {
        self.trustedPublicKey = trustedPublicKey
        self.fileManager = fileManager
        if let installRoot {
            self.installRoot = installRoot.standardizedFileURL
        } else {
            let documents = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first
                ?? fileManager.temporaryDirectory
            self.installRoot = documents.appendingPathComponent("ZeroModels", isDirectory: true).standardizedFileURL
        }
    }

    /// The detached signature covers the exact manifestPayload bytes. Producers
    /// must sign those exact bytes; the importer never reserializes before verify.
    /// Existing installs are never overwritten and no unverified fallback exists.
    @discardableResult
    public func install(packageAt sourcePackageURL: URL, manifestPayload: Data, signature: Data, for variant: Llama32Variant) throws -> URL {
        guard let trustedPublicKey else { throw ImportError.trustedKeyMissing }
        guard !manifestPayload.isEmpty, manifestPayload.count <= Self.maximumManifestBytes else {
            throw ImportError.invalidManifest("Manifestgröße ist ungültig.")
        }

        let publicKey: Curve25519.Signing.PublicKey
        do {
            publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: trustedPublicKey)
        } catch {
            throw ImportError.invalidPublicKey
        }
        guard publicKey.isValidSignature(signature, for: manifestPayload) else {
            throw ImportError.invalidSignature
        }

        let manifest: CoreMLArtifactManifest
        do {
            manifest = try JSONDecoder().decode(CoreMLArtifactManifest.self, from: manifestPayload)
        } catch {
            throw ImportError.invalidManifest("JSON kann nicht gelesen werden.")
        }
        try validateManifest(manifest, for: variant)
        let source = sourcePackageURL.standardizedFileURL
        try verifyPackage(at: source, manifest: manifest)

        do {
            try fileManager.createDirectory(at: installRoot, withIntermediateDirectories: true)
            let rootValues = try installRoot.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard rootValues.isDirectory == true, rootValues.isSymbolicLink != true else {
                throw ImportError.filesystem("Installationsverzeichnis ist kein sicherer Ordner.")
            }

            let destination = installRoot.appendingPathComponent(variant.bundleModelFilename, isDirectory: true)
            guard !fileManager.fileExists(atPath: destination.path) else {
                throw ImportError.destinationAlreadyExists
            }

            // Staging is on the same volume as the final destination. The copied
            // tree is re-verified before the final directory rename.
            let staging = installRoot.appendingPathComponent(".zero-staging-\(UUID().uuidString)", isDirectory: true)
            defer { try? fileManager.removeItem(at: staging) }
            try fileManager.createDirectory(at: staging, withIntermediateDirectories: false)
            let stagedPackage = staging.appendingPathComponent("package", isDirectory: true)
            try fileManager.copyItem(at: source, to: stagedPackage)
            try verifyPackage(at: stagedPackage, manifest: manifest)

            guard !fileManager.fileExists(atPath: destination.path) else {
                throw ImportError.destinationAlreadyExists
            }
            try fileManager.moveItem(at: stagedPackage, to: destination)
            return destination
        } catch let error as ImportError {
            throw error
        } catch {
            throw ImportError.filesystem(error.localizedDescription)
        }
    }

    public static func packageDigest(for records: [CoreMLArtifactManifest.FileRecord]) -> String {
        let canonical = records.sorted { $0.path < $1.path }.map {
            "\($0.path)\u{0}\($0.size)\u{0}\($0.sha256.lowercased())\n"
        }.joined()
        return hex(SHA256.hash(data: Data(canonical.utf8)))
    }

    private func validateManifest(_ manifest: CoreMLArtifactManifest, for variant: Llama32Variant) throws {
        guard manifest.schemaVersion == 1 else {
            throw ImportError.invalidManifest("Nicht unterstützte Schema-Version.")
        }
        guard manifest.modelVariant == variant.rawValue else {
            throw ImportError.invalidManifest("Modellvariante stimmt nicht mit dem Installationsziel überein.")
        }
        guard Self.isSHA256(manifest.packageSHA256), !manifest.files.isEmpty,
              manifest.files.count <= Self.maximumFileCount else {
            throw ImportError.invalidManifest("Dateiliste oder Paket-Hash ist ungültig.")
        }

        var seen = Set<String>()
        var normalizedPaths = Set<String>()
        var total: UInt64 = 0
        for record in manifest.files {
            guard Self.isSafeRelativePath(record.path), record.path.utf8.count <= Self.maximumRelativePathBytes else {
                throw ImportError.invalidManifest("Unsicherer relativer Dateipfad.")
            }
            guard seen.insert(record.path).inserted else {
                throw ImportError.invalidManifest("Doppelter Dateipfad.")
            }
            let normalizedPath = record.path.precomposedStringWithCanonicalMapping.lowercased()
            guard normalizedPaths.insert(normalizedPath).inserted else {
                throw ImportError.invalidManifest("Dateipfade kollidieren auf case-insensitiven oder Unicode-normalisierenden Dateisystemen.")
            }
            guard record.size > 0, record.size <= Self.maximumFileBytes, Self.isSHA256(record.sha256) else {
                throw ImportError.invalidManifest("Dateigröße oder SHA-256 ist ungültig.")
            }
            let (next, overflow) = total.addingReportingOverflow(record.size)
            guard !overflow, next <= Self.maximumPackageBytes else { throw ImportError.sizeLimitExceeded }
            total = next
        }
        guard Self.packageDigest(for: manifest.files) == manifest.packageSHA256.lowercased() else {
            throw ImportError.invalidManifest("Deterministischer Paket-Hash stimmt nicht.")
        }
    }

    private func verifyPackage(at packageURL: URL, manifest: CoreMLArtifactManifest) throws {
        let rootValues: URLResourceValues
        do {
            rootValues = try packageURL.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        } catch {
            throw ImportError.invalidPackage("Paketverzeichnis kann nicht gelesen werden.")
        }
        guard rootValues.isDirectory == true, rootValues.isSymbolicLink != true else {
            throw ImportError.invalidPackage("Paketwurzel ist kein reguläres Verzeichnis.")
        }

        var actualFiles = Set<String>()
        var entryCount = 0
        guard let enumerator = fileManager.enumerator(
            at: packageURL,
            includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey],
            options: []
        ) else {
            throw ImportError.invalidPackage("Paketinhalt kann nicht aufgelistet werden.")
        }

        for case let url as URL in enumerator {
            entryCount += 1
            guard entryCount <= Self.maximumPackageEntries else {
                throw ImportError.sizeLimitExceeded
            }
            let values: URLResourceValues
            do {
                values = try url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey])
            } catch {
                throw ImportError.invalidPackage("Dateimetadaten sind nicht lesbar.")
            }
            guard values.isSymbolicLink != true else {
                throw ImportError.invalidPackage("Symbolische Links sind verboten.")
            }
            if values.isDirectory == true { continue }
            guard values.isRegularFile == true else {
                throw ImportError.invalidPackage("Nicht reguläre Dateieinträge sind verboten.")
            }

            let relative = String(url.standardizedFileURL.path.dropFirst(packageURL.path.count + 1))
            guard Self.isSafeRelativePath(relative),
                  relative.utf8.count <= Self.maximumRelativePathBytes,
                  actualFiles.insert(relative).inserted else {
                throw ImportError.invalidPackage("Unsicherer oder doppelter Dateipfad.")
            }
        }

        let expected = Set(manifest.files.map(\.path))
        guard actualFiles == expected else {
            throw ImportError.invalidPackage("Paketdateien stimmen nicht exakt mit dem Manifest überein.")
        }

        for record in manifest.files {
            let fileURL = packageURL.appendingPathComponent(record.path)
            let values = try fileURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else {
                throw ImportError.invalidPackage("Manifestdatei ist kein reguläres, sicheres File.")
            }
            let attributes = try fileManager.attributesOfItem(atPath: fileURL.path)
            guard let size = (attributes[.size] as? NSNumber)?.uint64Value, size == record.size else {
                throw ImportError.invalidPackage("Dateigröße weicht vom Manifest ab.")
            }
            guard try Self.sha256(of: fileURL) == record.sha256.lowercased() else {
                throw ImportError.invalidPackage("SHA-256-Prüfung einer Paketdatei fehlgeschlagen.")
            }
        }
    }

    private static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let chunk = try handle.read(upToCount: 1024 * 1024) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hex(hasher.finalize())
    }

    private static func isSafeRelativePath(_ path: String) -> Bool {
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\"), !path.contains("\0") else {
            return false
        }
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.isEmpty else { return false }
        return components.allSatisfy { component in
            !component.isEmpty && component != "." && component != ".." &&
            !component.contains(":") &&
            component.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
        }
    }

    private static func isSHA256(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy {
            (48...57).contains($0) || (97...102).contains($0) || (65...70).contains($0)
        }
    }

    private static func hex<D: Sequence>(_ digest: D) -> String where D.Element == UInt8 {
        digest.map { String(format: "%02x", $0) }.joined()
    }
}
