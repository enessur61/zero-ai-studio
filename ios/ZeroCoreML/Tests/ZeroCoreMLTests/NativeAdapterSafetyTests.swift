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
