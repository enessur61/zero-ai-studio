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
            modelURL: missingURL,
            permitsSyntheticFixture: true
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

    func testVersionedLlamaContractsFailClosedForBothVariants() async {
        XCTAssertEqual(LlamaCoreMLModelContract.schemaVersion, 1)
        for variant in Llama32Variant.allCases {
            let evidence = LlamaCoreMLModelContract.evidence(for: variant)
            XCTAssertFalse(evidence.isProductionReady)
            XCTAssertNil(evidence.artifactSHA256)
            XCTAssertNil(evidence.inputTensorSpecifications)
            XCTAssertNil(evidence.outputTensorSpecifications)
            XCTAssertNil(evidence.stateTensorSpecifications)
            XCTAssertNil(evidence.attentionMaskSpecification)

            let session = CoreMLInferenceSession(variant: variant, computeUnits: .cpuOnly)
            do {
                try await session.loadModelIfNeeded()
                XCTFail("Unverified Llama artifact must never load")
            } catch CoreMLAdapterError.modelContractUnverified(_, _) {
                // Expected: production inference is blocked until artifact evidence exists.
            } catch {
                XCTFail("Unexpected error: \(error)")
            }
        }
    }

    func testCausalMaskAdvancesWithSequencePositionAndUsesCausalUpperTriangle() throws {
        let first = try CoreMLInferenceSession.makeCausalMask(
            sequenceLength: 1, startPosition: 0, contextLimit: 8
        )
        XCTAssertEqual(first.shape.map(\.intValue), [1, 1, 1, 1])
        XCTAssertEqual(first[[0, 0, 0, 0]].floatValue, 0)

        let advanced = try CoreMLInferenceSession.makeCausalMask(
            sequenceLength: 2, startPosition: 1, contextLimit: 8
        )
        XCTAssertEqual(advanced.shape.map(\.intValue), [1, 1, 2, 3])
        XCTAssertEqual(advanced[[0, 0, 0, 0]].floatValue, 0)
        XCTAssertEqual(advanced[[0, 0, 0, 1]].floatValue, 0)
        XCTAssertEqual(advanced[[0, 0, 0, 2]].floatValue, -65504)
        XCTAssertEqual(advanced[[0, 0, 1, 2]].floatValue, 0)
    }

    func testSequenceWindowRejectsContextOverflowAndInvalidPositions() throws {
        _ = try CoreMLInferenceSession.makeCausalMask(
            sequenceLength: 1, startPosition: 4095, contextLimit: 4096
        )
        XCTAssertThrowsError(try CoreMLInferenceSession.makeCausalMask(
            sequenceLength: 1, startPosition: 4096, contextLimit: 4096
        ))
        XCTAssertThrowsError(try CoreMLInferenceSession.makeCausalMask(
            sequenceLength: 2, startPosition: 4095, contextLimit: 4096
        ))
        XCTAssertThrowsError(try CoreMLInferenceSession.makeCausalMask(
            sequenceLength: 1, startPosition: -1, contextLimit: 4096
        ))
        XCTAssertThrowsError(try CoreMLInferenceSession.makeCausalMask(
            sequenceLength: 1, startPosition: Int.max, contextLimit: 4096
        ))
        XCTAssertThrowsError(try CoreMLInferenceSession.makeCausalMask(
            sequenceLength: 0, startPosition: 0, contextLimit: 4096
        ))
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
            // Cancel from inside the task before crossing the actor boundary.
            // This removes the scheduling race where the checkpoint can finish
            // before an immediate external cancel reaches the task.
            withUnsafeCurrentTask { currentTask in
                currentTask?.cancel()
            }
            try await session.cancellationCheckpoint()
        }

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
        func trace(_ message: String) {
            FileHandle.standardError.write(Data("[stateful-fixture] \(message)\n".utf8))
        }
        trace("test entered")
        guard let fixturePath = ProcessInfo.processInfo.environment["ZERO_STATEFUL_COREML_FIXTURE"] else {
            throw XCTSkip("Set ZERO_STATEFUL_COREML_FIXTURE to the generated stateful .mlpackage.")
        }
        let fixtureURL = URL(fileURLWithPath: fixturePath, isDirectory: true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixtureURL.path))
        trace("fixture path verified")

        trace("before MLModel.compileModel")
        let compiledURL = try await MLModel.compileModel(at: fixtureURL)
        trace("after MLModel.compileModel")
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .cpuOnly
        trace("before MLModel load")
        let model = try MLModel(contentsOf: compiledURL, configuration: configuration)
        trace("after MLModel load")
        XCTAssertNotNil(model.modelDescription.stateDescriptionsByName["k_cache"])
        XCTAssertNotNil(model.modelDescription.stateDescriptionsByName["v_cache"])
        trace("state descriptions verified")

        trace("before direct makeState")
        let directStateA = model.makeState()
        let directStateB = model.makeState()
        trace("after direct makeState")
        func cacheValue(_ state: MLState, name: String) -> Float {
            state.withMultiArray(for: name) { array in array[0].floatValue }
        }
        XCTAssertEqual(cacheValue(directStateA, name: "k_cache"), 0)
        XCTAssertEqual(cacheValue(directStateA, name: "v_cache"), 0)
        XCTAssertEqual(cacheValue(directStateB, name: "k_cache"), 0)
        XCTAssertEqual(cacheValue(directStateB, name: "v_cache"), 0)

        func features(token: Int32, startPosition: Int) throws -> MLDictionaryFeatureProvider {
            let ids = try MLMultiArray(shape: [1, 1], dataType: .int32)
            ids[[0, 0]] = NSNumber(value: token)
            let mask = try CoreMLInferenceSession.makeCausalMask(
                sequenceLength: 1,
                startPosition: startPosition,
                contextLimit: 8
            )
            XCTAssertEqual(mask.shape.map(\.intValue), [1, 1, 1, startPosition + 1])
            for column in 0...startPosition {
                XCTAssertEqual(
                    mask[[0, 0, 0, NSNumber(value: column)]].floatValue,
                    0,
                    "Past and current positions must remain visible"
                )
            }
            return try MLDictionaryFeatureProvider(dictionary: [
                "inputIds": MLFeatureValue(multiArray: ids),
                "causalMask": MLFeatureValue(multiArray: mask)
            ])
        }

        // Interleave two independent states while advancing each sequence position.
        // The real Core ML model must accept causalMask widths 1, 2, then 3.
        trace("before direct A position 0")
        _ = try await model.prediction(from: features(token: 2, startPosition: 0), using: directStateA)
        trace("after direct A position 0")
        XCTAssertEqual(cacheValue(directStateA, name: "k_cache"), 2)
        XCTAssertEqual(cacheValue(directStateA, name: "v_cache"), 4)
        XCTAssertEqual(cacheValue(directStateB, name: "k_cache"), 0)
        XCTAssertEqual(cacheValue(directStateB, name: "v_cache"), 0)

        trace("before direct B position 0")
        _ = try await model.prediction(from: features(token: 9, startPosition: 0), using: directStateB)
        trace("after direct B position 0")
        trace("before direct A position 1")
        _ = try await model.prediction(from: features(token: 5, startPosition: 1), using: directStateA)
        trace("after direct A position 1")
        trace("before direct B position 1")
        _ = try await model.prediction(from: features(token: 2, startPosition: 1), using: directStateB)
        trace("after direct B position 1")
        trace("before direct A position 2")
        _ = try await model.prediction(from: features(token: 3, startPosition: 2), using: directStateA)
        trace("after direct A position 2")
        trace("before direct B position 2")
        _ = try await model.prediction(from: features(token: 4, startPosition: 2), using: directStateB)
        trace("after direct B position 2")
        XCTAssertEqual(cacheValue(directStateA, name: "k_cache"), 10)
        XCTAssertEqual(cacheValue(directStateA, name: "v_cache"), 20)
        XCTAssertEqual(cacheValue(directStateB, name: "k_cache"), 15)
        XCTAssertEqual(cacheValue(directStateB, name: "v_cache"), 30)

        // Exercise the production actor-owned session with two real K/V MLState instances.
        let session = CoreMLInferenceSession(
            variant: .instruct1B,
            computeUnits: .cpuOnly,
            modelURL: compiledURL,
            permitsSyntheticFixture: true
        )
        trace("before actor session load")
        try await session.loadModelIfNeeded()
        trace("after actor session load")
        let stateA = try await session.makeState()
        let stateB = try await session.makeState()
        trace("actor session states created")
        trace("before actor A position 0")
        let aFirst = try await session.predictStep(inputIds: [2], startPosition: 0, stateID: stateA)
        trace("after actor A position 0")
        trace("before actor B position 0")
        let bFirst = try await session.predictStep(inputIds: [9], startPosition: 0, stateID: stateB)
        trace("after actor B position 0")
        trace("before actor A position 1")
        let aSecond = try await session.predictStep(inputIds: [5], startPosition: 1, stateID: stateA)
        trace("after actor A position 1")
        trace("before actor B position 1")
        let bSecond = try await session.predictStep(inputIds: [2], startPosition: 1, stateID: stateB)
        trace("after actor B position 1")
        trace("before actor A position 2")
        let aThird = try await session.predictStep(inputIds: [3], startPosition: 2, stateID: stateA)
        trace("after actor A position 2")
        trace("before actor B position 2")
        let bThird = try await session.predictStep(inputIds: [4], startPosition: 2, stateID: stateB)
        trace("after actor B position 2")
        XCTAssertEqual(aFirst, [2])
        XCTAssertEqual(bFirst, [9])
        XCTAssertEqual(aSecond, [7])
        XCTAssertEqual(bSecond, [11])
        XCTAssertEqual(aThird, [10])
        XCTAssertEqual(bThird, [15])
        let bothStatesActive = await session.activeStateCount()
        XCTAssertEqual(bothStatesActive, 2)

        await session.releaseState(stateA)
        let oneStateActive = await session.activeStateCount()
        XCTAssertEqual(oneStateActive, 1)
        await session.releaseState(stateB)
        let noStatesActive = await session.activeStateCount()
        XCTAssertEqual(noStatesActive, 0)

        // Unload invalidates every registered state; reload starts cleanly.
        let stateC = try await session.makeState()
        await session.unloadModel()
        let unloadedStateCount = await session.activeStateCount()
        XCTAssertEqual(unloadedStateCount, 0)
        do {
            _ = try await session.predictStep(inputIds: [3], startPosition: 0, stateID: stateC)
            XCTFail("A state must not survive model unload")
        } catch CoreMLAdapterError.invalidInputTensor {
            // Expected: unload removed the state registry.
        }
        try await session.loadModelIfNeeded()
        let stateD = try await session.makeState()
        let afterReload = try await session.predictStep(inputIds: [4], startPosition: 0, stateID: stateD)
        XCTAssertEqual(afterReload, [4])
        await session.releaseState(stateD)
        await session.releaseState(stateD)
        let afterRepeatedRelease = await session.activeStateCount()
        XCTAssertEqual(afterRepeatedRelease, 0)
    }

}
