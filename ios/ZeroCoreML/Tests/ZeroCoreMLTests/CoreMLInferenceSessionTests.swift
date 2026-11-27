import XCTest
import CoreML
@testable import ZeroCoreML

final class CoreMLInferenceSessionTests: XCTestCase {
    func testMissingModelURLThrowsTypedBundleError() async {
        let missingURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("zero-missing-\(UUID().uuidString).mlmodelc", isDirectory: true)
        let session = CoreMLInferenceSession(
            variant: .instruct1B,
            computeUnits: .cpuOnly,
            modelURL: missingURL
        )

        do {
            try await session.loadModelIfNeeded()
            XCTFail("Expected missing model error")
        } catch let error as CoreMLAdapterError {
            guard case .modelBundleMissing = error else {
                XCTFail("Expected modelBundleMissing, received: \(error)")
                return
            }
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testUnknownStateIdentifierIsRejectedWithoutCreatingState() async {
        let first = CoreMLInferenceSession(
            variant: .instruct1B,
            computeUnits: .cpuOnly,
            modelURL: nil
        )
        let foreignState = UUID()

        do {
            _ = try await first.predictStep(
                inputIds: [1],
                startPosition: 0,
                stateID: foreignState
            )
            XCTFail("A state not owned by this session must be rejected")
        } catch let error as CoreMLAdapterError {
            guard case .invalidInputTensor = error else {
                XCTFail("Expected invalidInputTensor, received: \(error)")
                return
            }
        } catch {
            XCTFail("Unexpected error: \(error)")
        }

        let firstStateCount = await first.activeStateCount()
        XCTAssertEqual(firstStateCount, 0)
    }

    func testConcurrentInvalidStateRequestsAreRejectedWithoutCreatingStates() async {
        let session = CoreMLInferenceSession(
            variant: .instruct1B,
            computeUnits: .cpuOnly,
            modelURL: nil
        )

        let rejectedCount = await withTaskGroup(of: Bool.self, returning: Int.self) { group in
            for _ in 0..<32 {
                group.addTask {
                    do {
                        _ = try await session.predictStep(
                            inputIds: [7],
                            startPosition: 0,
                            stateID: UUID()
                        )
                        return false
                    } catch CoreMLAdapterError.invalidInputTensor {
                        return true
                    } catch {
                        return false
                    }
                }
            }

            var count = 0
            for await rejected in group where rejected {
                count += 1
            }
            return count
        }

        let activeStateCount = await session.activeStateCount()
        XCTAssertEqual(rejectedCount, 32)
        XCTAssertEqual(activeStateCount, 0)
    }

    func testLogitsAreCopiedIntoSendableFloatBufferWithoutReordering() throws {
        let logits = try MLMultiArray(shape: [3], dataType: .float32)
        logits[0] = NSNumber(value: -1.25)
        logits[1] = NSNumber(value: 0.5)
        logits[2] = NSNumber(value: 3.75)

        XCTAssertEqual(CoreMLInferenceSession.copyLogits(logits), [-1.25, 0.5, 3.75])
    }

    func testCancellationCheckpointPropagatesTaskCancellation() async {
        let session = CoreMLInferenceSession(
            variant: .instruct1B,
            computeUnits: .cpuOnly,
            modelURL: nil
        )
        let task = Task {
            try await session.cancellationCheckpoint()
        }
        task.cancel()

        do {
            try await task.value
            XCTFail("Expected CancellationError")
        } catch is CancellationError {
            // Expected.
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }
    func testRealStatefulModelMaintainsIndependentMLStatesAndSessionCaches() async throws {
        guard let fixturePath = ProcessInfo.processInfo.environment["ZERO_STATEFUL_COREML_FIXTURE"] else {
            throw XCTSkip("Set ZERO_STATEFUL_COREML_FIXTURE to the generated stateful .mlpackage.")
        }
        let fixtureURL = URL(fileURLWithPath: fixturePath, isDirectory: true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixtureURL.path))

        // Compile the actual MIL-generated .mlpackage with the host Core ML runtime.
        let compiledURL = try MLModel.compileModel(at: fixtureURL)
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .cpuOnly
        let model = try MLModel(contentsOf: compiledURL, configuration: configuration)
        XCTAssertNotNil(model.modelDescription.stateDescriptionsByName["accumulator"])

        // Inspect two genuine Core ML state buffers and prove they do not alias.
        let directStateA = model.makeState()
        let directStateB = model.makeState()
        func accumulatorValue(_ state: MLState) -> Float {
            state.withMultiArray(for: "accumulator") { array in
                array[0].floatValue
            }
        }
        XCTAssertEqual(accumulatorValue(directStateA), 0)
        XCTAssertEqual(accumulatorValue(directStateB), 0)

        func features(token: Int32) throws -> MLDictionaryFeatureProvider {
            let ids = try MLMultiArray(shape: [1, 1], dataType: .int32)
            ids[[0, 0]] = NSNumber(value: token)
            let mask = try MLMultiArray(shape: [1, 1, 1, 1], dataType: .float16)
            mask[[0, 0, 0, 0]] = NSNumber(value: 0)
            return try MLDictionaryFeatureProvider(dictionary: [
                "inputIds": MLFeatureValue(multiArray: ids),
                "causalMask": MLFeatureValue(multiArray: mask)
            ])
        }

        _ = try model.prediction(from: features(token: 2), using: directStateA)
        XCTAssertEqual(accumulatorValue(directStateA), 2)
        XCTAssertEqual(accumulatorValue(directStateB), 0, "Updating state A must not mutate state B.")

        _ = try model.prediction(from: features(token: 9), using: directStateB)
        _ = try model.prediction(from: features(token: 5), using: directStateA)
        _ = try model.prediction(from: features(token: 2), using: directStateB)
        XCTAssertEqual(accumulatorValue(directStateA), 7)
        XCTAssertEqual(accumulatorValue(directStateB), 11)

        // Exercise the production actor/session path with its own real MLState objects.
        let session = CoreMLInferenceSession(
            variant: .instruct1B,
            computeUnits: .cpuOnly,
            modelURL: compiledURL
        )
        try await session.loadModelIfNeeded()
        let stateA = try await session.makeState()
        let stateB = try await session.makeState()
        XCTAssertEqual(try await session.predictStep(inputIds: [2], startPosition: 0, stateID: stateA), [2])
        XCTAssertEqual(try await session.predictStep(inputIds: [9], startPosition: 0, stateID: stateB), [9])
        XCTAssertEqual(try await session.predictStep(inputIds: [5], startPosition: 1, stateID: stateA), [7])
        XCTAssertEqual(try await session.predictStep(inputIds: [2], startPosition: 1, stateID: stateB), [11])
        XCTAssertEqual(await session.activeStateCount(), 2)

        await session.releaseState(stateA)
        XCTAssertEqual(await session.activeStateCount(), 1)
        await session.releaseState(stateB)
        XCTAssertEqual(await session.activeStateCount(), 0)
    }

}
