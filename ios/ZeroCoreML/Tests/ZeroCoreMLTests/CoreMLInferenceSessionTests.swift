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

        let compiledURL = try MLModel.compileModel(at: fixtureURL)
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .cpuOnly
        let model = try MLModel(contentsOf: compiledURL, configuration: configuration)
        XCTAssertNotNil(model.modelDescription.stateDescriptionsByName["k_cache"])
        XCTAssertNotNil(model.modelDescription.stateDescriptionsByName["v_cache"])

        // Verify two genuine MLState instances begin with independent K/V buffers.
        let directStateA = model.makeState()
        let directStateB = model.makeState()
        func cacheValue(_ state: MLState, name: String) -> Float {
            state.withMultiArray(for: name) { array in array[0].floatValue }
        }
        XCTAssertEqual(cacheValue(directStateA, name: "k_cache"), 0)
        XCTAssertEqual(cacheValue(directStateA, name: "v_cache"), 0)
        XCTAssertEqual(cacheValue(directStateB, name: "k_cache"), 0)
        XCTAssertEqual(cacheValue(directStateB, name: "v_cache"), 0)

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
        XCTAssertEqual(cacheValue(directStateA, name: "k_cache"), 2)
        XCTAssertEqual(cacheValue(directStateA, name: "v_cache"), 4)
        XCTAssertEqual(cacheValue(directStateB, name: "k_cache"), 0)
        XCTAssertEqual(cacheValue(directStateB, name: "v_cache"), 0)

        _ = try model.prediction(from: features(token: 9), using: directStateB)
        _ = try model.prediction(from: features(token: 5), using: directStateA)
        _ = try model.prediction(from: features(token: 2), using: directStateB)
        XCTAssertEqual(cacheValue(directStateA, name: "k_cache"), 7)
        XCTAssertEqual(cacheValue(directStateA, name: "v_cache"), 14)
        XCTAssertEqual(cacheValue(directStateB, name: "k_cache"), 11)
        XCTAssertEqual(cacheValue(directStateB, name: "v_cache"), 22)

        // Exercise the exact model/state wrapper used by the production Llama actor.
        let productionModel = CoreMLModelReference(model)
        let stateA = productionModel.makeState()
        let stateB = productionModel.makeState()
        let aFirst = try await productionModel.prediction(
            inputIds: [2], startPosition: 0, state: stateA
        )
        let bFirst = try await productionModel.prediction(
            inputIds: [9], startPosition: 0, state: stateB
        )
        let aSecond = try await productionModel.prediction(
            inputIds: [5], startPosition: 0, state: stateA
        )
        let bSecond = try await productionModel.prediction(
            inputIds: [2], startPosition: 0, state: stateB
        )
        func logit(_ output: CoreMLLogits) -> Float {
            output.value[0].floatValue
        }
        XCTAssertEqual(logit(aFirst), 2)
        XCTAssertEqual(logit(bFirst), 9)
        XCTAssertEqual(logit(aSecond), 7)
        XCTAssertEqual(logit(bSecond), 11)
        XCTAssertEqual(cacheValue(stateA.value, name: "k_cache"), 7)
        XCTAssertEqual(cacheValue(stateA.value, name: "v_cache"), 14)
        XCTAssertEqual(cacheValue(stateB.value, name: "k_cache"), 11)
        XCTAssertEqual(cacheValue(stateB.value, name: "v_cache"), 22)
    }

}
