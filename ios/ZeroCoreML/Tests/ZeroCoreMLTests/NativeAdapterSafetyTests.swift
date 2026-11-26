import XCTest
import AVFoundation
import AudioToolbox
@testable import ZeroCoreML

final class NativeAdapterSafetyTests: XCTestCase {
    func testPiperWAVEncoderWritesMonoPCM16AndClampsSamples() {
        let wav = PiperONNXAdapter.encodeWavRIFF(
            samples: [-1.5, 0.0, 1.5],
            sampleRate: 22_050
        )

        XCTAssertEqual(wav.count, 50)
        XCTAssertEqual(String(data: wav[0..<4], encoding: .ascii), "RIFF")
        XCTAssertEqual(readUInt32LE(wav, at: 4), 42)
        XCTAssertEqual(String(data: wav[8..<12], encoding: .ascii), "WAVE")
        XCTAssertEqual(readUInt16LE(wav, at: 22), 1, "WAV must be mono")
        XCTAssertEqual(readUInt32LE(wav, at: 24), 22_050)
        XCTAssertEqual(readUInt16LE(wav, at: 34), 16, "WAV must contain PCM16 samples")
        XCTAssertEqual(readUInt32LE(wav, at: 40), 6)
        XCTAssertEqual(Array(wav[44..<50]), [0x00, 0x80, 0x00, 0x00, 0xff, 0x7f])
    }

    func testKokoroModelLocatorUsesTheCatalogBundleFilename() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("zero-kokoro-model-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let expectedName = "kokoro-v1_0-82m.mlmodelc"
        let expectedDirectory = root
            .appendingPathComponent("ZeroModels", isDirectory: true)
            .appendingPathComponent(expectedName, isDirectory: true)
        try FileManager.default.createDirectory(
            at: expectedDirectory,
            withIntermediateDirectories: true
        )

        let adapter = KokoroMLXAudioAdapter()
        XCTAssertEqual(adapter.bundleName, expectedName)
        let located = KokoroMLXAudioAdapter.locateModelURL(
            bundleName: adapter.bundleName,
            bundle: .main,
            documentsDirectory: root
        )
        XCTAssertEqual(located?.standardizedFileURL, expectedDirectory.standardizedFileURL)
    }

    func testWhisperSegmentFormatsSRTWithMillisecondPrecision() {
        let segment = WhisperSegment(
            index: 1,
            startTimeMs: 1_234,
            endTimeMs: 5_678,
            text: "Guten Abend."
        )

        XCTAssertEqual(
            segment.srtBlock,
            "1\n00:00:01,234 --> 00:00:05,678\nGuten Abend."
        )
    }

    func testWhisperRejectsCorruptAudioWithTypedError() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("zero-corrupt-audio-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: url) }
        try Data("not a WAV file".utf8).write(to: url)

        XCTAssertThrowsError(
            try WhisperMetalAdapter().loadAudioAs16kMonoFloat(audioURL: url)
        ) { error in
            guard case WhisperAdapterError.invalidAudioFormat = error else {
                XCTFail("Expected invalidAudioFormat, received: \(error)")
                return
            }
        }
    }

    func testWhisperRejectsEmptyAudioFileWithTypedError() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("zero-empty-audio-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: url) }

        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16_000.0,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false
        ]
        do {
            let writer = try AVAudioFile(forWriting: url, settings: settings)
            XCTAssertEqual(writer.length, 0)
        }

        XCTAssertThrowsError(
            try WhisperMetalAdapter().loadAudioAs16kMonoFloat(audioURL: url)
        ) { error in
            guard case WhisperAdapterError.invalidAudioFormat = error else {
                XCTFail("Expected invalidAudioFormat, received: \(error)")
                return
            }
        }
    }

    func testNativeAudioImportUsesOpaqueUUIDAndPrivateCanonicalPath() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("zero-audio-import-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try NativeAudioImportStore(baseDirectory: root, lifetime: 60)
        let source = root.deletingLastPathComponent().appendingPathComponent("zero-valid-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: source) }
        try makeValidWAV(at: source)

        let importId = try store.importAudio(from: source)
        XCTAssertNotNil(UUID(uuidString: importId))
        let resolved = try store.resolve(importId)
        XCTAssertEqual(resolved.deletingLastPathComponent().standardizedFileURL, root.standardizedFileURL)
        XCTAssertTrue(FileManager.default.fileExists(atPath: resolved.path))

        store.remove(importId)
        XCTAssertThrowsError(try store.resolve(importId))
    }

    func testNativeAudioImportRejectsPathTraversalAndMalformedIdentifiers() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("zero-audio-path-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try NativeAudioImportStore(baseDirectory: root)

        XCTAssertThrowsError(try store.resolve("../../Documents/private.wav")) { error in
            guard case NativeAudioImportError.invalidIdentifier = error else {
                XCTFail("Expected invalidIdentifier, received: \(error)")
                return
            }
        }
    }

    func testNativeAudioImportRejectsExpiredIdentifiers() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("zero-audio-expiry-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        let store = try NativeAudioImportStore(baseDirectory: root, lifetime: 5, now: { clock })
        let source = root.deletingLastPathComponent().appendingPathComponent("zero-expiring-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: source) }
        try makeValidWAV(at: source)
        let importId = try store.importAudio(from: source)

        clock = clock.addingTimeInterval(6)
        XCTAssertThrowsError(try store.resolve(importId)) { error in
            guard case NativeAudioImportError.expiredOrMissing = error else {
                XCTFail("Expected expiredOrMissing, received: \(error)")
                return
            }
        }
    }

    func testNativeAudioImportRejectsInvalidAudioFiles() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("zero-audio-invalid-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("invalid.wav")
        try Data("not audio".utf8).write(to: source)
        let store = try NativeAudioImportStore(baseDirectory: root.appendingPathComponent("imports"))

        XCTAssertThrowsError(try store.importAudio(from: source)) { error in
            guard case NativeAudioImportError.invalidAudioFile = error else {
                XCTFail("Expected invalidAudioFile, received: \(error)")
                return
            }
        }
    }

    func testNativeAudioImportCleanupRemovesExpiredFiles() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("zero-audio-cleanup-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var clock = Date(timeIntervalSince1970: 1_800_000_100)
        let store = try NativeAudioImportStore(baseDirectory: root, lifetime: 2, now: { clock })
        let source = root.deletingLastPathComponent().appendingPathComponent("zero-cleanup-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: source) }
        try makeValidWAV(at: source)
        let importId = try store.importAudio(from: source)
        let importedURL = try store.resolve(importId)

        clock = clock.addingTimeInterval(3)
        XCTAssertEqual(store.cleanupExpired(), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: importedURL.path))
        XCTAssertThrowsError(try store.resolve(importId))
    }

    private func makeValidWAV(at url: URL) throws {
        let data = PiperONNXAdapter.encodeWavRIFF(
            samples: Array(repeating: 0.1, count: 1_600),
            sampleRate: 16_000
        )
        try data.write(to: url)
    }

    private func readUInt16LE(_ data: Data, at offset: Int) -> UInt16 {
        UInt16(data[offset]) | (UInt16(data[offset + 1]) << 8)
    }

    private func readUInt32LE(_ data: Data, at offset: Int) -> UInt32 {
        UInt32(data[offset])
            | (UInt32(data[offset + 1]) << 8)
            | (UInt32(data[offset + 2]) << 16)
            | (UInt32(data[offset + 3]) << 24)
    }
}
