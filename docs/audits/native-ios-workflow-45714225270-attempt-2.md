# Native iOS workflow audit — run 45714225270, attempt 2

- Workflow: [ZERO Native iOS App Build](https://github.com/enessur61/zero-ai-studio/actions/runs/45714225270)
- Run ID: `45714225270`
- Attempt: `2`
- Job: `build-ios-app` (`139702829534`)
- Final run conclusion: **failure**
- Final job conclusion: **failure**
- Updated: `2026-11-26T05:03:32Z`
- Pull request checkout: `9dac642423947ae6033bc581bd5e73d7794a3e73`
- PR merge commit message: `Merge 957dac0de0e1afbd5c64f073390dfc2daeb630c1 into 11b691a9a512ac25de3ac03949934e7b77c45c50`

## Step results

| Step | Result |
|---|---|
| Set up job | success |
| Checkout | success |
| Build pinned XcodeGen 2.46.0 | success |
| Run ZeroCoreML Swift 6 XCTest suite | **failure** |
| Generate Xcode project | skipped |
| Build unsigned iOS Simulator app | skipped |
| Build unsigned iPhone device app | skipped |
| Package unsigned IPA | skipped |
| Upload unsigned IPA | skipped |

## Relevant log excerpt

```text
2026-11-26T05:03:09.4797490Z Run swift test --package-path ios/ZeroCoreML
2026-11-26T05:03:25.0492820Z LlamaCoreMLAdapter.swift:196:22: error: expression is 'async' but is not marked with 'await'
2026-11-26T05:03:25.0495290Z let output = try model.prediction(from: provider, using: state)
2026-11-26T05:03:27.5282470Z ZeroWKWebViewBridge.swift:116:29: error: call to actor-isolated instance method 'deploymentDiagnostics()' in a synchronous main actor-isolated context
2026-11-26T05:03:27.5284940Z let d = adapter.deploymentDiagnostics()
2026-11-26T05:03:27.5538890Z error: fatalError
2026-11-26T05:03:27.5603700Z Process completed with exit code 1.
```

XcodeGen's pinned source commit `8445e778451c7e44237b90281bde622d764b0084` built successfully and reported version 2.46.0. The failure was in Swift compilation, not XcodeGen bootstrap or runner cancellation.

## Follow-up validation

The above log belongs to the historical merge checkout and must not be confused with later branch commits. Subsequent commits added `await` at the diagnostics call and at CoreML prediction. A later run exposed the additional Swift 6 `SendingRisksDataRace` diagnostic at the prediction call; this was addressed separately by wrapping the CoreML model, per-generation state and logits behind narrow `@unchecked Sendable` handles. That follow-up must be validated by the current Native iOS workflow before claiming success.

## Scope

No provider calls, GPU bookings, merges or deployments were performed as part of this audit.
