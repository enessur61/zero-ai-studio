import XCTest
import CryptoKit
@testable import ZeroCoreML

final class CoreMLArtifactImportStoreTests: XCTestCase {
    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("zero-import-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func syntheticProvenance(_ variant: Llama32Variant = .instruct1B, revision: String = String(repeating: "a", count: 40), tokenizerRevision: String? = nil, outputs: [[String: Any]]? = nil) throws -> Data {
        let hash = String(repeating: "b", count: 64)
        let file = [["path": "fixture.bin", "size": 1, "sha256": hash] as [String: Any]]
        let packageOutputs = outputs ?? file
        let object: [String: Any] = [
            "schema_version": 1,
            "model": ["publisher": "Meta", "model_id": variant == .instruct1B ? "meta-llama/Llama-3.2-1B-Instruct" : "meta-llama/Llama-3.2-3B-Instruct", "variant": variant.rawValue, "source_revision": revision],
            "license": ["license_id": "SYNTHETIC-TEST-ONLY", "accepted": true, "acceptance_record": "SYNTHETIC-TEST-ONLY-REFERENCE", "files": file],
            "tokenizer": ["source_revision": tokenizerRevision ?? revision, "files": file],
            "toolchain": ["runner_image": "SYNTHETIC-TEST-ONLY", "os_build": "SYNTHETIC-TEST-ONLY", "architecture": "SYNTHETIC-TEST-ONLY", "xcode_build": "SYNTHETIC-TEST-ONLY", "sdk": "SYNTHETIC-TEST-ONLY", "swift": "SYNTHETIC-TEST-ONLY", "python": "3.12.test", "pytorch": "SYNTHETIC-TEST-ONLY", "coremltools": "8.3.0.test", "lock_sha256": hash, "converter_revision": revision],
            "conversion": ["command": "SYNTHETIC-TEST-ONLY", "profile": "SYNTHETIC-TEST-ONLY", "graph_capture_method": "SYNTHETIC-TEST-ONLY", "deployment_target": "SYNTHETIC-TEST-ONLY", "precision_profile": "SYNTHETIC-TEST-ONLY", "pass_pipeline": "SYNTHETIC-TEST-ONLY", "options": [:]],
            "inputs": file, "outputs": packageOutputs,
            "coreml_evidence": ["extracted_from_artifact": true, "extraction_tool_version": "SYNTHETIC-TEST-ONLY", "inputs": file, "outputs": file, "states": [["name": "state", "data_type": "SYNTHETIC-TEST-ONLY", "shape": [1]]]],
            "validation": ["cpu_only": true, "tests": [["name": "synthetic", "passed": true, "report_sha256": hash]]],
            "reproducibility": ["build_id": "SYNTHETIC-BUILD-A", "independent_rebuild": ["status": "identical", "build_id": "SYNTHETIC-BUILD-B", "primary_package_sha256": hash, "comparison_package_sha256": hash, "canonical_inventory_sha256": hash, "report_sha256": hash]],
            "signing": ["algorithm": "Ed25519", "key_id": "SYNTHETIC-TEST-ONLY", "signature_file": "SYNTHETIC-TEST-ONLY.sig", "signer_provenance": "SYNTHETIC-TEST-ONLY"]
        ]
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private func makeManifest(_ records: [CoreMLArtifactManifest.FileRecord], variant: Llama32Variant = .instruct1B, provenance: Data? = nil, revision: String? = nil) throws -> CoreMLArtifactManifest {
        let outputRecords = records.map { ["path": $0.path, "size": $0.size, "sha256": $0.sha256] as [String: Any] }
        let data = try provenance ?? syntheticProvenance(variant, revision: revision ?? String(repeating: "a", count: 40), outputs: outputRecords)
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return CoreMLArtifactManifest(modelVariant: variant.rawValue, packageSHA256: CoreMLArtifactImportStore.packageDigest(for: records), files: records, provenanceJSON: data, provenanceSHA256: digest)
    }

    private func makePackage(at root: URL, content: Data = Data("model-fixture".utf8)) throws -> (URL, CoreMLArtifactManifest) {
        let package = root.appendingPathComponent("source.mlmodelc", isDirectory: true)
        try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
        let file = package.appendingPathComponent("model.bin")
        try content.write(to: file)
        let hash = SHA256.hash(data: content).map { String(format: "%02x", $0) }.joined()
        let record = CoreMLArtifactManifest.FileRecord(path: "model.bin", size: UInt64(content.count), sha256: hash)
        let manifest = try makeManifest([record])
        return (package, manifest)
    }

    private func signedPayload(_ manifest: CoreMLArtifactManifest, key: Curve25519.Signing.PrivateKey) throws -> (Data, Data) {
        let payload = try JSONEncoder().encode(manifest)
        return (payload, try key.signature(for: payload))
    }

    private func assertImportRejected(
        package: URL,
        manifest: CoreMLArtifactManifest,
        key: Curve25519.Signing.PrivateKey,
        root: URL,
        variant: Llama32Variant = .instruct1B
    ) throws {
        let (payload, signature) = try signedPayload(manifest, key: key)
        let store = CoreMLArtifactImportStore(trustedPublicKey: key.publicKey.rawRepresentation, installRoot: root)
        XCTAssertThrowsError(try store.install(packageAt: package, manifestPayload: payload, signature: signature, for: variant))
    }

    func testValidSignedPackageIsVerifiedCopiedAndInstalled() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let (package, manifest) = try makePackage(at: root)
        let key = Curve25519.Signing.PrivateKey()
        let (payload, signature) = try signedPayload(manifest, key: key)
        let store = CoreMLArtifactImportStore(trustedPublicKey: key.publicKey.rawRepresentation, installRoot: root.appendingPathComponent("ZeroModels"))
        let installed = try store.install(packageAt: package, manifestPayload: payload, signature: signature, for: .instruct1B)
        let installedFile = installed.appendingPathComponent("model.bin")
        XCTAssertTrue(FileManager.default.fileExists(atPath: installedFile.path))
        XCTAssertEqual(try Data(contentsOf: installedFile), Data("model-fixture".utf8))
        let verifier = CoreMLArtifactImportStore(trustedPublicKey: key.publicKey.rawRepresentation, installRoot: root.appendingPathComponent("ZeroModels"))
        XCTAssertNoThrow(try verifier.verifyInstalledPackage(at: installed, for: .instruct1B))
        try Data("tampered".utf8).write(to: installedFile)
        XCTAssertThrowsError(try verifier.verifyInstalledPackage(at: installed, for: .instruct1B))
    }

    func testInstalledPackageOutsideConfiguredTrustRootIsRejected() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let (sourcePackage, manifest) = try makePackage(at: root)
        let key = Curve25519.Signing.PrivateKey()
        let (payload, signature) = try signedPayload(manifest, key: key)
        let configuredRoot = root.appendingPathComponent("ConfiguredZeroModels")
        let store = CoreMLArtifactImportStore(trustedPublicKey: key.publicKey.rawRepresentation, installRoot: configuredRoot)
        let installed = try store.install(packageAt: sourcePackage, manifestPayload: payload, signature: signature, for: .instruct1B)

        let foreignRoot = root.appendingPathComponent("Foreign")
        let foreignEnvelope = foreignRoot.appendingPathComponent(CoreMLArtifactImportStore.installationDirectoryName(for: .instruct1B))
        try FileManager.default.createDirectory(at: foreignEnvelope, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: installed.deletingLastPathComponent().appendingPathComponent("model.mlmodelc"),
                                         to: foreignEnvelope.appendingPathComponent("model.mlmodelc"))
        try FileManager.default.copyItem(at: installed.deletingLastPathComponent().appendingPathComponent("manifest.json"),
                                         to: foreignEnvelope.appendingPathComponent("manifest.json"))
        try FileManager.default.copyItem(at: installed.deletingLastPathComponent().appendingPathComponent("manifest.sig"),
                                         to: foreignEnvelope.appendingPathComponent("manifest.sig"))
        XCTAssertThrowsError(try store.verifyInstalledPackage(
            at: foreignEnvelope.appendingPathComponent("model.mlmodelc"),
            for: .instruct1B
        ))
    }

    func testRuntimeVerificationRejectsTamperedSignature() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let (package, manifest) = try makePackage(at: root)
        let key = Curve25519.Signing.PrivateKey()
        let (payload, signature) = try signedPayload(manifest, key: key)
        let installRoot = root.appendingPathComponent("ZeroModels")
        let store = CoreMLArtifactImportStore(trustedPublicKey: key.publicKey.rawRepresentation, installRoot: installRoot)
        let installed = try store.install(packageAt: package, manifestPayload: payload, signature: signature, for: .instruct1B)
        try Data("bad-signature".utf8).write(to: installed.deletingLastPathComponent().appendingPathComponent("manifest.sig"))
        XCTAssertThrowsError(try store.verifyInstalledPackage(at: installed, for: .instruct1B))
    }

    func testPinnedPublicKeyConfigurationIsStrictAndFailClosed() {
        XCTAssertNil(CoreMLArtifactTrust.decodePinnedPublicKey(""))
        XCTAssertNil(CoreMLArtifactTrust.decodePinnedPublicKey("not-base64"))
        XCTAssertNil(CoreMLArtifactTrust.decodePinnedPublicKey(Data(repeating: 7, count: 31).base64EncodedString()))
        XCTAssertNil(CoreMLArtifactTrust.decodePinnedPublicKey(" " + Data(repeating: 7, count: 32).base64EncodedString()))
        XCTAssertEqual(CoreMLArtifactTrust.decodePinnedPublicKey(Data(repeating: 7, count: 32).base64EncodedString())?.count, 32)
    }

    func testMissingTrustedKeyFailsClosed() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let (package, manifest) = try makePackage(at: root)
        let (payload, signature) = try signedPayload(manifest, key: Curve25519.Signing.PrivateKey())
        let store = CoreMLArtifactImportStore(trustedPublicKey: nil, installRoot: root.appendingPathComponent("ZeroModels"))
        XCTAssertThrowsError(try store.install(packageAt: package, manifestPayload: payload, signature: signature, for: .instruct1B)) { error in
            guard case CoreMLArtifactImportStore.ImportError.trustedKeyMissing = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }
    }

    func testInvalidSignatureFailsBeforeInstallation() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let (package, manifest) = try makePackage(at: root)
        let signer = Curve25519.Signing.PrivateKey()
        let attacker = Curve25519.Signing.PrivateKey()
        let (payload, signature) = try signedPayload(manifest, key: attacker)
        let store = CoreMLArtifactImportStore(trustedPublicKey: signer.publicKey.rawRepresentation, installRoot: root.appendingPathComponent("ZeroModels"))
        XCTAssertThrowsError(try store.install(packageAt: package, manifestPayload: payload, signature: signature, for: .instruct1B))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("ZeroModels").appendingPathComponent(Llama32Variant.instruct1B.bundleModelFilename).path))
    }

    func testTamperedFileFailsHashVerification() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let (package, manifest) = try makePackage(at: root)
        try Data("tampered".utf8).write(to: package.appendingPathComponent("model.bin"))
        try assertImportRejected(package: package, manifest: manifest, key: Curve25519.Signing.PrivateKey(), root: root.appendingPathComponent("ZeroModels"))
    }

    func testUnexpectedFilesAndSymlinksAreRejected() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let (package, manifest) = try makePackage(at: root)
        try Data("extra".utf8).write(to: package.appendingPathComponent("unexpected.bin"))
        try assertImportRejected(package: package, manifest: manifest, key: Curve25519.Signing.PrivateKey(), root: root.appendingPathComponent("ZeroModels"))
    }

    func testTraversalDuplicateAndWrongVariantManifestsAreRejected() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let (package, validManifest) = try makePackage(at: root)
        let key = Curve25519.Signing.PrivateKey()
        let unsafe = CoreMLArtifactManifest.FileRecord(path: "../escape", size: 1, sha256: String(repeating: "a", count: 64))
        let traversal = try makeManifest([unsafe])
        try assertImportRejected(package: package, manifest: traversal, key: key, root: root.appendingPathComponent("Traversal"))
        let duplicate = validManifest.files[0]
        let duplicateManifest = try makeManifest([duplicate, duplicate])
        try assertImportRejected(package: package, manifest: duplicateManifest, key: key, root: root.appendingPathComponent("Duplicate"))
        try assertImportRejected(package: package, manifest: validManifest, key: key, root: root.appendingPathComponent("WrongVariant"), variant: .instruct3B)
    }

    func testExistingInstallationIsNeverOverwritten() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let (package, manifest) = try makePackage(at: root)
        let key = Curve25519.Signing.PrivateKey()
        let (payload, signature) = try signedPayload(manifest, key: key)
        let installRoot = root.appendingPathComponent("ZeroModels")
        let destination = installRoot.appendingPathComponent(CoreMLArtifactImportStore.installationDirectoryName(for: .instruct1B))
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        try Data("keep".utf8).write(to: destination.appendingPathComponent("keep.txt"))
        let store = CoreMLArtifactImportStore(trustedPublicKey: key.publicKey.rawRepresentation, installRoot: installRoot)
        XCTAssertThrowsError(try store.install(packageAt: package, manifestPayload: payload, signature: signature, for: .instruct1B))
        XCTAssertEqual(try Data(contentsOf: destination.appendingPathComponent("keep.txt")), Data("keep".utf8))
    }

    func testCaseAndUnicodeNormalizedPathCollisionsAreRejected() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let (package, _) = try makePackage(at: root)
        let hash = SHA256.hash(data: Data("model-fixture".utf8)).map { String(format: "%02x", $0) }.joined()
        let upper = CoreMLArtifactManifest.FileRecord(path: "Model.bin", size: 13, sha256: hash)
        let lower = CoreMLArtifactManifest.FileRecord(path: "model.bin", size: 13, sha256: hash)
        let manifest = try makeManifest([upper, lower])
        try assertImportRejected(package: package, manifest: manifest, key: Curve25519.Signing.PrivateKey(), root: root.appendingPathComponent("ZeroModels"))
    }

    func testMissingProvenanceIsRejected() throws {
        let root = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let (package, valid) = try makePackage(at: root)
        let missing = CoreMLArtifactManifest(modelVariant: valid.modelVariant, packageSHA256: valid.packageSHA256, files: valid.files)
        try assertImportRejected(package: package, manifest: missing, key: Curve25519.Signing.PrivateKey(), root: root.appendingPathComponent("Missing"))
    }

    func testIncorrectProvenanceDigestIsRejected() throws {
        let root = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let (package, valid) = try makePackage(at: root)
        let bad = CoreMLArtifactManifest(modelVariant: valid.modelVariant, packageSHA256: valid.packageSHA256, files: valid.files, provenanceJSON: valid.provenanceJSON, provenanceSHA256: String(repeating: "f", count: 64))
        try assertImportRejected(package: package, manifest: bad, key: Curve25519.Signing.PrivateKey(), root: root.appendingPathComponent("BadDigest"))
    }

    func testWrongModelRevisionInProvenanceIsRejected() throws {
        let root = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let (package, valid) = try makePackage(at: root)
        let wrong = try syntheticProvenance(.instruct1B, revision: String(repeating: "c", count: 40), tokenizerRevision: String(repeating: "d", count: 40))
        let bad = try makeManifest(valid.files, provenance: wrong)
        try assertImportRejected(package: package, manifest: bad, key: Curve25519.Signing.PrivateKey(), root: root.appendingPathComponent("WrongRevision"))
    }

    func testIncompleteToolchainEvidenceIsRejected() throws {
        let root = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let (package, valid) = try makePackage(at: root)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(valid.provenanceJSON)) as? [String: Any])
        var toolchain = try XCTUnwrap(object["toolchain"] as? [String: Any]); toolchain.removeValue(forKey: "lock_sha256"); object["toolchain"] = toolchain
        let badData = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let bad = try makeManifest(valid.files, provenance: badData)
        try assertImportRejected(package: package, manifest: bad, key: Curve25519.Signing.PrivateKey(), root: root.appendingPathComponent("IncompleteToolchain"))
    }

    func testModelIDMustMatchTheSelectedOfficialVariant() throws {
        let root = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let (package, valid) = try makePackage(at: root)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(valid.provenanceJSON)) as? [String: Any])
        var model = try XCTUnwrap(object["model"] as? [String: Any])
        model["model_id"] = "meta-llama/Llama-3.2-3B-Instruct"
        object["model"] = model
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let bad = try makeManifest(valid.files, provenance: data)
        try assertImportRejected(package: package, manifest: bad, key: Curve25519.Signing.PrivateKey(), root: root.appendingPathComponent("WrongModelID"))
    }

    func testLicenseAcceptanceRequiresSeparateReference() throws {
        let root = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let (package, valid) = try makePackage(at: root)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(valid.provenanceJSON)) as? [String: Any])
        var license = try XCTUnwrap(object["license"] as? [String: Any])
        license.removeValue(forKey: "acceptance_record")
        object["license"] = license
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let bad = try makeManifest(valid.files, provenance: data)
        try assertImportRejected(package: package, manifest: bad, key: Curve25519.Signing.PrivateKey(), root: root.appendingPathComponent("MissingAcceptanceReference"))
    }

    func testCoreMLStateMetadataIsRequired() throws {
        let root = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let (package, valid) = try makePackage(at: root)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(valid.provenanceJSON)) as? [String: Any])
        var evidence = try XCTUnwrap(object["coreml_evidence"] as? [String: Any])
        evidence["states"] = []
        object["coreml_evidence"] = evidence
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let bad = try makeManifest(valid.files, provenance: data)
        try assertImportRejected(package: package, manifest: bad, key: Curve25519.Signing.PrivateKey(), root: root.appendingPathComponent("MissingStateEvidence"))
    }

    func testConversionEvidenceRequiresDeclaredMethodAndOptions() throws {
        let root = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let (package, valid) = try makePackage(at: root)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(valid.provenanceJSON)) as? [String: Any])
        var conversion = try XCTUnwrap(object["conversion"] as? [String: Any])
        conversion.removeValue(forKey: "graph_capture_method")
        object["conversion"] = conversion
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let bad = try makeManifest(valid.files, provenance: data)
        try assertImportRejected(package: package, manifest: bad, key: Curve25519.Signing.PrivateKey(), root: root.appendingPathComponent("IncompleteConversion"))
    }

    func testIndependentRebuildEvidenceIsRequiredAndConsistent() throws {
        let root = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let (package, valid) = try makePackage(at: root)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(valid.provenanceJSON)) as? [String: Any])
        var reproducibility = try XCTUnwrap(object["reproducibility"] as? [String: Any])
        reproducibility.removeValue(forKey: "independent_rebuild")
        object["reproducibility"] = reproducibility
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let bad = try makeManifest(valid.files, provenance: data)
        try assertImportRejected(package: package, manifest: bad, key: Curve25519.Signing.PrivateKey(), root: root.appendingPathComponent("MissingIndependentRebuild"))
    }

    func testProvenanceOutputsMustMatchSignedPackageInventory() throws {
        let root = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let (package, valid) = try makePackage(at: root)
        let wrongOutput = [["path": "different.bin", "size": 1, "sha256": String(repeating: "b", count: 64)] as [String: Any]]
        let wrong = try syntheticProvenance(outputs: wrongOutput)
        let bad = try makeManifest(valid.files, provenance: wrong)
        try assertImportRejected(package: package, manifest: bad, key: Curve25519.Signing.PrivateKey(), root: root.appendingPathComponent("MismatchedOutputInventory"))
    }

    func testInstalledProvenanceTamperingIsRejectedAtRuntime() throws {
        let root = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let (package, manifest) = try makePackage(at: root)
        let key = Curve25519.Signing.PrivateKey()
        let (payload, signature) = try signedPayload(manifest, key: key)
        let installRoot = root.appendingPathComponent("ZeroModels")
        let store = CoreMLArtifactImportStore(trustedPublicKey: key.publicKey.rawRepresentation, installRoot: installRoot)
        let installed = try store.install(packageAt: package, manifestPayload: payload, signature: signature, for: .instruct1B)
        let envelope = installed.deletingLastPathComponent()
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(manifest.provenanceJSON)) as? [String: Any])
        object["tampered"] = true
        let changed = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        try changed.write(to: envelope.appendingPathComponent("provenance.json"))
        XCTAssertThrowsError(try store.verifyInstalledPackage(at: installed, for: .instruct1B))
    }

    func testSymlinkInsidePackageIsRejected() throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let (package, manifest) = try makePackage(at: root)
        let external = root.appendingPathComponent("outside.bin")
        try Data("outside".utf8).write(to: external)
        try FileManager.default.createSymbolicLink(at: package.appendingPathComponent("link.bin"), withDestinationURL: external)
        try assertImportRejected(package: package, manifest: manifest, key: Curve25519.Signing.PrivateKey(), root: root.appendingPathComponent("ZeroModels"))
    }
}
