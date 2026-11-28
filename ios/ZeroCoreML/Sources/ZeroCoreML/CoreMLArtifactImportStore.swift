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
    /// Raw UTF-8 provenance JSON is embedded in the signed import envelope.
    /// Its digest is independently checked before install and at every runtime verification.
    public let provenanceSHA256: String?
    public let provenanceJSON: Data?

    public init(schemaVersion: Int = 1, modelVariant: String, packageSHA256: String, files: [FileRecord], provenanceJSON: Data? = nil, provenanceSHA256: String? = nil) {
        self.schemaVersion = schemaVersion
        self.modelVariant = modelVariant
        self.packageSHA256 = packageSHA256
        self.files = files
        self.provenanceJSON = provenanceJSON
        self.provenanceSHA256 = provenanceSHA256
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
        guard !manifestPayload.isEmpty, manifestPayload.count <= Self.maximumManifestBytes, signature.count == 64 else {
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
        try validateManifest(manifest, for: variant, trustedPublicKey: trustedPublicKey)
        let source = sourcePackageURL.standardizedFileURL
        try verifyPackage(at: source, manifest: manifest)

        do {
            try fileManager.createDirectory(at: installRoot, withIntermediateDirectories: true)
            let rootValues = try installRoot.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard rootValues.isDirectory == true, rootValues.isSymbolicLink != true else {
                throw ImportError.filesystem("Installationsverzeichnis ist kein sicherer Ordner.")
            }

            let destination = installRoot.appendingPathComponent(Self.installationDirectoryName(for: variant), isDirectory: true)
            guard !fileManager.fileExists(atPath: destination.path) else {
                throw ImportError.destinationAlreadyExists
            }
            // Package and signed metadata share one same-volume staging envelope.
            // A single directory rename publishes all three atomically.
            let staging = installRoot.appendingPathComponent(".zero-staging-\(UUID().uuidString)", isDirectory: true)
            defer { try? fileManager.removeItem(at: staging) }
            try fileManager.createDirectory(at: staging, withIntermediateDirectories: false)
            let stagedPackage = staging.appendingPathComponent("model.mlmodelc", isDirectory: true)
            try fileManager.copyItem(at: source, to: stagedPackage)
            try verifyPackage(at: stagedPackage, manifest: manifest)
            try manifestPayload.write(to: staging.appendingPathComponent("manifest.json"), options: .atomic)
            try signature.write(to: staging.appendingPathComponent("manifest.sig"), options: .atomic)
            guard let provenance = manifest.provenanceJSON else { throw ImportError.invalidManifest("Provenienz fehlt.") }
            try provenance.write(to: staging.appendingPathComponent("provenance.json"), options: .atomic)
            guard !fileManager.fileExists(atPath: destination.path) else {
                throw ImportError.destinationAlreadyExists
            }
            try fileManager.moveItem(at: staging, to: destination)
            return destination.appendingPathComponent("model.mlmodelc", isDirectory: true)
        } catch let error as ImportError {
            throw error
        } catch {
            throw ImportError.filesystem(error.localizedDescription)
        }
    }

    public static func installationDirectoryName(for variant: Llama32Variant) -> String {
        "\(variant.bundleModelFilename).verified-install"
    }

    /// Re-verifies the detached signature and every package file at the point of use.
    public func verifyInstalledPackage(at packageURL: URL, for variant: Llama32Variant) throws {
        guard let trustedPublicKey else { throw ImportError.trustedKeyMissing }
        let normalizedPackageURL = packageURL.standardizedFileURL
        let envelope = normalizedPackageURL.deletingLastPathComponent()
        let normalizedInstallRoot = installRoot.standardizedFileURL
        guard envelope.deletingLastPathComponent().standardizedFileURL == normalizedInstallRoot,
              normalizedPackageURL.lastPathComponent == "model.mlmodelc",
              envelope.lastPathComponent == Self.installationDirectoryName(for: variant) else {
            throw ImportError.invalidPackage("Installationspaket liegt außerhalb des festgelegten Trust-Roots oder hat einen unerwarteten Pfad.")
        }
        let rootValues = try normalizedInstallRoot.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        let envelopeValues = try envelope.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard rootValues.isDirectory == true, rootValues.isSymbolicLink != true else {
            throw ImportError.invalidPackage("Installations-Trust-Root ist kein reguläres Verzeichnis.")
        }
        let manifestURL = envelope.appendingPathComponent("manifest.json")
        let signatureURL = envelope.appendingPathComponent("manifest.sig")
        let manifestValues = try manifestURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        let signatureValues = try signatureURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard envelopeValues.isDirectory == true, envelopeValues.isSymbolicLink != true,
              manifestValues.isRegularFile == true, manifestValues.isSymbolicLink != true,
              signatureValues.isRegularFile == true, signatureValues.isSymbolicLink != true else {
            throw ImportError.invalidPackage("Installationsmetadaten oder Verzeichnis sind keine regulären sicheren Dateien.")
        }
        let manifestAttributes = try fileManager.attributesOfItem(atPath: manifestURL.path)
        let signatureAttributes = try fileManager.attributesOfItem(atPath: signatureURL.path)
        guard let manifestSize = (manifestAttributes[.size] as? NSNumber)?.uint64Value,
              manifestSize > 0, manifestSize <= UInt64(Self.maximumManifestBytes),
              let signatureSize = (signatureAttributes[.size] as? NSNumber)?.uint64Value,
              signatureSize == 64 else {
            throw ImportError.invalidManifest("Manifest- oder Signaturgröße ist ungültig.")
        }
        let manifestPayload = try Data(contentsOf: manifestURL, options: [.mappedIfSafe])
        let signature = try Data(contentsOf: signatureURL, options: [.mappedIfSafe])
        let publicKey: Curve25519.Signing.PublicKey
        do { publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: trustedPublicKey) }
        catch { throw ImportError.invalidPublicKey }
        guard publicKey.isValidSignature(signature, for: manifestPayload) else {
            throw ImportError.invalidSignature
        }
        let manifest: CoreMLArtifactManifest
        do { manifest = try JSONDecoder().decode(CoreMLArtifactManifest.self, from: manifestPayload) }
        catch { throw ImportError.invalidManifest("JSON kann nicht gelesen werden.") }
        try validateManifest(manifest, for: variant, trustedPublicKey: trustedPublicKey)
        let provenanceURL = envelope.appendingPathComponent("provenance.json")
        let provenanceValues = try provenanceURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard provenanceValues.isRegularFile == true, provenanceValues.isSymbolicLink != true,
              let expectedProvenance = manifest.provenanceJSON,
              try Data(contentsOf: provenanceURL) == expectedProvenance else {
            throw ImportError.invalidManifest("Installierte Provenienz fehlt oder wurde nach der Installation manipuliert.")
        }
        try verifyPackage(at: normalizedPackageURL, manifest: manifest)
    }

    public static func packageDigest(for records: [CoreMLArtifactManifest.FileRecord]) -> String {
        let canonical = records.sorted { $0.path < $1.path }.map {
            "\($0.path)\u{0}\($0.size)\u{0}\($0.sha256.lowercased())\n"
        }.joined()
        return hex(SHA256.hash(data: Data(canonical.utf8)))
    }

    private func validateManifest(_ manifest: CoreMLArtifactManifest, for variant: Llama32Variant, trustedPublicKey: Data) throws {
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
        guard let provenance = manifest.provenanceJSON,
              let provenanceDigest = manifest.provenanceSHA256,
              Self.isSHA256(provenanceDigest),
              Self.hex(SHA256.hash(data: provenance)) == provenanceDigest.lowercased() else {
            throw ImportError.invalidManifest("Provenienz fehlt oder ihr SHA-256 stimmt nicht.")
        }
        let trustedKeyID = "sha256:" + Self.hex(SHA256.hash(data: trustedPublicKey))
        try Self.validateProvenance(provenance, expectedVariant: variant, expectedKeyID: trustedKeyID, packageFiles: manifest.files)
    }

    /// Validates required evidence sections without assigning any real model values.
    /// Synthetic test records are accepted only as structural fixtures; this method
    /// does not grant production approval or populate LlamaCoreMLModelContract.
    private static func validateProvenance(
        _ data: Data,
        expectedVariant: Llama32Variant,
        expectedKeyID: String,
        packageFiles: [CoreMLArtifactManifest.FileRecord]
    ) throws {
        guard data.count > 0, data.count <= maximumManifestBytes,
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ImportError.invalidManifest("Provenienz-JSON ist ungültig.")
        }

        let required = ["schema_version", "model", "license", "tokenizer", "toolchain", "conversion", "inputs", "outputs", "coreml_evidence", "validation", "reproducibility", "signing"]
        let expectedModelID = expectedVariant == .instruct1B
            ? "meta-llama/Llama-3.2-1B-Instruct"
            : "meta-llama/Llama-3.2-3B-Instruct"

        guard required.allSatisfy({ root[$0] != nil }),
              (root["schema_version"] as? Int) == 1,
              let model = root["model"] as? [String: Any],
              (model["publisher"] as? String) == "Meta",
              (model["variant"] as? String) == expectedVariant.rawValue,
              (model["model_id"] as? String) == expectedModelID,
              let revision = model["source_revision"] as? String,
              revision.count == 40, revision == revision.lowercased(), revision.allSatisfy({ $0.isHexDigit }),
              let license = root["license"] as? [String: Any],
              let licenseID = license["license_id"] as? String, !licenseID.isEmpty,
              (license["accepted"] as? Bool) == true,
              let acceptanceRecord = license["acceptance_record"] as? String, !acceptanceRecord.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let licenseFiles = license["files"] as? [[String: Any]], !licenseFiles.isEmpty,
              let tokenizer = root["tokenizer"] as? [String: Any],
              (tokenizer["source_revision"] as? String) == revision,
              let tokenizerFiles = tokenizer["files"] as? [[String: Any]], !tokenizerFiles.isEmpty,
              let toolchain = root["toolchain"] as? [String: Any],
              let python = toolchain["python"] as? String, !python.isEmpty,
              let pytorch = toolchain["pytorch"] as? String, !pytorch.isEmpty,
              let coremltools = toolchain["coremltools"] as? String, !coremltools.isEmpty,
              let xcode = toolchain["xcode_build"] as? String, !xcode.isEmpty,
              let sdk = toolchain["sdk"] as? String, !sdk.isEmpty,
              let swift = toolchain["swift"] as? String, !swift.isEmpty,
              let osBuild = toolchain["os_build"] as? String, !osBuild.isEmpty,
              let architecture = toolchain["architecture"] as? String, !architecture.isEmpty,
              let runner = toolchain["runner_image"] as? String, !runner.isEmpty,
              let lockHash = toolchain["lock_sha256"] as? String, isSHA256(lockHash),
              let converterRevision = toolchain["converter_revision"] as? String,
              converterRevision.count == 40, converterRevision == converterRevision.lowercased(), converterRevision.allSatisfy({ $0.isHexDigit }),
              let conversion = root["conversion"] as? [String: Any],
              let command = conversion["command"] as? String, !command.isEmpty,
              let profile = conversion["profile"] as? String, !profile.isEmpty,
              let graphCapture = conversion["graph_capture_method"] as? String, !graphCapture.isEmpty,
              let deploymentTarget = conversion["deployment_target"] as? String, !deploymentTarget.isEmpty,
              let precisionProfile = conversion["precision_profile"] as? String, !precisionProfile.isEmpty,
              let passPipeline = conversion["pass_pipeline"] as? String, !passPipeline.isEmpty,
              conversion["options"] as? [String: Any] != nil,
              let inputs = root["inputs"] as? [[String: Any]], !inputs.isEmpty,
              let outputs = root["outputs"] as? [[String: Any]], !outputs.isEmpty,
              let evidence = root["coreml_evidence"] as? [String: Any],
              (evidence["extracted_from_artifact"] as? Bool) == true,
              let extractionTool = evidence["extraction_tool_version"] as? String, !extractionTool.isEmpty,
              let coremlInputs = evidence["inputs"] as? [[String: Any]], !coremlInputs.isEmpty,
              let coremlOutputs = evidence["outputs"] as? [[String: Any]], !coremlOutputs.isEmpty,
              let coremlStates = evidence["states"] as? [[String: Any]], !coremlStates.isEmpty,
              let validation = root["validation"] as? [String: Any],
              (validation["cpu_only"] as? Bool) == true,
              let validationTests = validation["tests"] as? [[String: Any]], !validationTests.isEmpty,
              let reproducibility = root["reproducibility"] as? [String: Any],
              let primaryBuildID = reproducibility["build_id"] as? String, !primaryBuildID.isEmpty,
              let comparison = reproducibility["independent_rebuild"] as? [String: Any],
              let comparisonStatus = comparison["status"] as? String,
              comparisonStatus == "identical" || comparisonStatus == "different",
              let comparisonBuildID = comparison["build_id"] as? String,
              !comparisonBuildID.isEmpty, comparisonBuildID != primaryBuildID,
              let primaryDigest = comparison["primary_package_sha256"] as? String, isSHA256(primaryDigest),
              let comparisonDigest = comparison["comparison_package_sha256"] as? String, isSHA256(comparisonDigest),
              let inventoryDigest = comparison["canonical_inventory_sha256"] as? String, isSHA256(inventoryDigest),
              let comparisonReport = comparison["report_sha256"] as? String, isSHA256(comparisonReport),
              let signing = root["signing"] as? [String: Any],
              (signing["algorithm"] as? String) == "Ed25519",
              let keyID = signing["key_id"] as? String, keyID == expectedKeyID,
              let signatureFile = signing["signature_file"] as? String, !signatureFile.isEmpty,
              let signerProvenance = signing["signer_provenance"] as? String, !signerProvenance.isEmpty else {
            throw ImportError.invalidManifest("Provenienz ist unvollständig, widersprüchlich oder enthält keine vollständige Toolchain-/Artefakt-/Reproduzierbarkeitsevidenz.")
        }

        guard (comparisonStatus == "identical" && primaryDigest == comparisonDigest)
                || (comparisonStatus == "different" && primaryDigest != comparisonDigest) else {
            throw ImportError.invalidManifest("Reproduzierbarkeitsstatus widerspricht den unabhängigen Paket-Hashes.")
        }

        func validatedInventory(_ records: [[String: Any]], label: String) throws -> [String: (UInt64, String)] {
            var result: [String: (UInt64, String)] = [:]
            for item in records {
                guard let path = item["path"] as? String,
                      isSafeRelativePath(path), path.utf8.count <= maximumRelativePathBytes,
                      let sizeNumber = item["size"] as? NSNumber, sizeNumber.uint64Value > 0,
                      let hash = item["sha256"] as? String, isSHA256(hash),
                      result[path] == nil else {
                    throw ImportError.invalidManifest("\(label)-Dateiinventar ist unvollständig, unsicher oder enthält Duplikate.")
                }
                result[path] = (sizeNumber.uint64Value, hash.lowercased())
            }
            return result
        }

        let licenseInventory = try validatedInventory(licenseFiles, label: "Lizenz")
        let tokenizerInventory = try validatedInventory(tokenizerFiles, label: "Tokenizer")
        let inputInventory = try validatedInventory(inputs, label: "Input")
        let outputInventory = try validatedInventory(outputs, label: "Output")
        guard licenseInventory.allSatisfy({ inputInventory[$0.key]?.0 == $0.value.0 && inputInventory[$0.key]?.1 == $0.value.1 }),
              tokenizerInventory.allSatisfy({ inputInventory[$0.key]?.0 == $0.value.0 && inputInventory[$0.key]?.1 == $0.value.1 }) else {
            throw ImportError.invalidManifest("Lizenz-/Tokenizer-Inventar ist nicht konsistent an die Input-Hashes gebunden.")
        }

        var packageInventory: [String: (UInt64, String)] = [:]
        for record in packageFiles {
            packageInventory[record.path] = (record.size, record.sha256.lowercased())
        }
        guard outputInventory.count == packageInventory.count,
              outputInventory.allSatisfy({ packageInventory[$0.key]?.0 == $0.value.0 && packageInventory[$0.key]?.1 == $0.value.1 }) else {
            throw ImportError.invalidManifest("Provenienz-Output-Inventar stimmt nicht exakt mit dem signierten Paketmanifest überein.")
        }

        for (label, records) in [("Input", coremlInputs), ("Output", coremlOutputs), ("State", coremlStates)] {
            for record in records {
                guard let name = record["name"] as? String, !name.isEmpty,
                      let dataType = record["data_type"] as? String, !dataType.isEmpty,
                      let shape = record["shape"] as? [Any], !shape.isEmpty else {
                    throw ImportError.invalidManifest("Core-ML-\(label)-Metadaten sind unvollständig.")
                }
            }
        }
        for test in validationTests {
            guard let name = test["name"] as? String, !name.isEmpty,
                  (test["passed"] as? Bool) == true,
                  let reportHash = test["report_sha256"] as? String, isSHA256(reportHash) else {
                throw ImportError.invalidManifest("CPU-Validierungsnachweis ist unvollständig oder fehlgeschlagen.")
            }
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
