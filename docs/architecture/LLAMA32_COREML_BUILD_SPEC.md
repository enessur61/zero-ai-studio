# ZERO Llama 3.2 1B / 3B – Reproducible CPU-only Core ML Build Specification

**Status:** Design specification only; not an implementation or production approval.  
**Applies to:** Meta Llama 3.2 1B Instruct and 3B Instruct, as two separate build targets.  
**Repository baseline reviewed:** PR #123 head `c71575960592cec02cf30ae2700d7d3ca66e5704`.  
**Security posture:** Fail closed. No model weights, Core ML artifacts, signing keys, or tensor contracts are supplied by this document.

## 1. Purpose and non-goals

Define an auditable build that can, after separate authorization and lawful source acquisition, convert an immutable official Meta source revision into a ZERO-controlled Core ML package. The build must bind source weights, source configuration, tokenizer, conversion code, toolchain, license notices, output inventory, and release signature into one provenance record.

This document does **not**:
- download or install model weights;
- perform a conversion or create an `.mlpackage` / `.mlmodelc`;
- assert any model input, output, state, KV-cache, attention-mask, dtype, shape, or sequence-length specification;
- create, select, or embed a public/private key;
- claim Meta has signed or endorsed a third-party Core ML conversion;
- enable a model in the application or relax `LlamaCoreMLModelContract`;
- authorize GPU, Neural Engine, provider, or production deployment activity.

## 2. Existing repository boundaries (reviewed)

The following existing files were inspected at the baseline commit:

| Existing path | Observed responsibility | Rule for this specification |
|---|---|---|
| `ios/ZeroCoreML/Tests/Fixtures/generate_stateful_fixture.py` | Generates a tiny synthetic stateful Core ML fixture for XCTest | Test fixture only; never repurpose as Llama converter |
| `.github/workflows/ios-app.yml` | Native ARM64 iOS build; installs Python 3.12 and CoreMLTools 8.3.0 for the fixture | Keep model conversion in a separate workflow |
| `ios/ZeroCoreML/Package.swift` | Swift 6 package, iOS 18 / macOS 15 platform declarations | Do not mix Python build dependencies into Swift package |
| `ios/ZEROAIStudio/project.yml` | iOS 18 target; trust-anchor Info.plist entry deliberately empty | Do not populate trust anchor from this spec |
| `ios/ZeroCoreML/Sources/ZeroCoreML/LlamaCoreMLModelContract.swift` | Production evidence fields intentionally nil and readiness false | Remains fail-closed until evidence is extracted from actual output artifacts |
| `ios/ZeroCoreML/Sources/ZeroCoreML/CoreMLArtifactImportStore.swift` | Signed manifest, package inventory and hash verification | Build output must conform to its eventual, separately verified import contract |

No existing Llama conversion pipeline, Python dependency lock for Core ML conversion, real model package, concrete Llama tokenizer implementation, or model-specific tensor evidence was found in the reviewed tree.

## 3. Trust and source-of-truth hierarchy

Each model size is an independent build subject. Do not mix 1B and 3B files or revisions.

1. **Upstream model source:** official Meta repository/download channel only. Record the exact repository identifier, immutable 40-character source commit/revision, access/download timestamp, and every acquired file's byte length and SHA-256. A mutable branch name or a model-card label is insufficient.
2. **License source:** retain the exact license text, Acceptable Use Policy and any applicable notices from the source revision. Record their hashes and the acceptance/authorization record outside the public build log. A successful download is not proof of license compliance.
3. **Tokenizer source:** acquire tokenizer/config/template assets from the same official model family and immutable revision as the weights. Bind every tokenizer file by relative path, byte length and SHA-256. Do not silently substitute a community tokenizer, a newer revision, or a tokenizer inferred from a similarly named model.
4. **Conversion toolchain:** pin the converter source revision and every binary/package dependency. Record provenance separately from upstream model provenance.
5. **ZERO release signature:** a detached signature made by an authorized ZERO release signer attests to the exact produced manifest bytes. It does not represent a Meta signature, does not certify Meta's endorsement, and must not be described as such.

If official source revision, licensing rights, tokenizer correspondence, or source file integrity cannot be established, stop before conversion.

## 4. Target matrix

| Field | 1B target | 3B target |
|---|---|---|
| Model identity | Llama 3.2 1B Instruct | Llama 3.2 3B Instruct |
| Upstream publisher | Meta | Meta |
| Official source repository/revision | Must be recorded and immutable; currently unset | Must be recorded and immutable; currently unset |
| License / AUP evidence | Exact acquired text and hashes required | Exact acquired text and hashes required |
| Tokenizer | Same model family + exact immutable source revision; hashes required | Same model family + exact immutable source revision; hashes required |
| Conversion profile | Separate profile and output | Separate profile and output |
| Artifact evidence | Extract from actual built package only | Extract from actual built package only |
| Production status | Blocked | Blocked |

No source commit, tokenizer hash, model digest, tensor contract, or artifact digest is pre-populated because none has been verified for an acquired source package.

## 5. Toolchain and dependency locking

### 5.1 Known baseline versus required final pins

| Component | Current repository observation | Required release-build rule |
|---|---|---|
| CoreMLTools | Fixture workflow installs `coremltools==8.3.0` | Start from 8.3.0 only as a candidate; validate the actual Llama graph and freeze exact wheel hash before approving |
| Python | Workflow requests `3.12` | Pin exact patch version and implementation/build; record `python --version` and executable/platform metadata |
| PyTorch | Not pinned in the inspected fixture workflow | Select only after converter compatibility test; exact version + wheel SHA-256 mandatory |
| torchvision / torchaudio | Not established as required | Include only if dependency analysis proves they are needed; exact version + hash |
| transformers / safetensors / tokenizers | No conversion lock found | Pin exact versions and wheel hashes; record upstream source revision separately |
| pip / build frontend | Not pinned by current fixture command | Pin installer/build tools and record versions |
| macOS runner | `macos-15` label | Label is mutable; record actual image version/build and architecture. Release build requires an immutable runner image or explicit image-version acceptance |
| Xcode | CI reports actual version dynamically; no fixed version in workflow | Pin exact Xcode build/version and SDK; fail if actual version differs |
| Swift | Swift 6 language mode; actual compiler supplied by Xcode | Record exact `swift --version` output and bind it to the Xcode build |
| XcodeGen | 2.46.0 source commit pinned | Retain exact source commit and verify produced binary provenance/hash |
| Actions | Existing workflow uses full action commit SHAs | Continue full-SHA pinning for every action |

**Important:** `macos-15`, Python `3.12`, and an Xcode major/minor label are not immutable pins. They are insufficient alone for a reproducibility claim.

### 5.2 Lock format

Use one dedicated, reviewed lock for the conversion environment (for example, a hash-enforced pip-tools requirements lock or an equivalently verifiable lock format). The committed lock must:
- pin every direct and transitive dependency to an exact version;
- contain accepted SHA-256 hashes for every installable wheel/sdist;
- reject unhashed dependencies and unpinned VCS URLs;
- define the supported platform/Python ABI for the build runner;
- be generated from a separately reviewed input file;
- be installed in hash-checking mode (e.g. `pip install --require-hashes`);
- be accompanied by the lock generator version and generation procedure.

Do not invent package hashes or select PyTorch/Transformers versions by guesswork. Resolve and verify them only in a later, authorized toolchain-validation task. Prefer a retained, hash-verified wheelhouse for release builds. Network access should be limited to the approved acquisition stage; the conversion stage should consume only the verified local inputs and locked wheelhouse.

### 5.3 Reproducibility definition

Distinguish:
- **Input reproducibility:** exact same source files, tokenizer files, license notices, toolchain and conversion source.
- **Process reproducibility:** same declared build commands, environment variables, hardware/OS image and conversion options.
- **Artifact integrity:** exact SHA-256 inventory of the produced package.
- **Bit-for-bit reproducibility:** identical package bytes on independent rebuilds.

Do not claim bit-for-bit reproducibility until two clean independent builds produce identical canonical package inventories and hashes. If Core ML compilation embeds nondeterministic metadata, document that limitation and retain both raw package hashes plus a canonical content inventory; do not normalize away executable content or security-relevant metadata.

## 6. Build isolation and CPU-only policy

Use a dedicated workflow separate from `.github/workflows/ios-app.yml`. It must have read-only repository permissions by default and must not possess deployment credentials, provider credentials, or model-release signing private keys.

Stages:
1. **Acquire (separately authorized):** retrieve only the approved official source revision, tokenizer assets and license materials. No third-party model mirrors as an implicit fallback.
2. **Verify inputs:** check immutable source revision, expected file inventory, file sizes and SHA-256; reject missing, extra, duplicate, symlink, traversal or path-collision entries.
3. **Prepare locked environment:** install only from the hash-locked wheelhouse/lock.
4. **Convert:** run the reviewed converter on native Apple Silicon/macOS using CPU-based conversion operations. No cloud inference endpoint, provider, hosted generation service, GPU worker or GPU reservation.
5. **Inspect:** inspect the resulting package and Core ML model description; capture actual metadata without synthesizing or guessing missing values.
6. **Validate:** run deterministic structural checks and CPU-only Core ML smoke tests using an explicitly CPU-only compute-unit configuration where prediction is performed.
7. **Package evidence:** produce manifest, license notices, source provenance, dependency lock, SBOM and test report.
8. **Sign:** only in a separately authorized release-signing stage, after review, using the organization's actual protected signing key. Never expose private keys to pull-request builds.

Core ML Tools' `compute_units=CPU_ONLY` is a model execution/prediction setting; it is not proof that the conversion compiler itself has selected a CPU-only execution backend. For conversion, enforce the CPU-only environment operationally: no GPU/provider job, no external inference, no GPU reservation, no prediction on GPU/Neural Engine. If the selected Core ML Tools API supports `skip_model_load=True` for the conversion path, use it to avoid implicit post-conversion model loading, then perform a separate explicit CPU-only validation stage. Confirm behavior against the exact pinned CoreMLTools release before implementation.

A CPU-only build may still run on a host that physically contains a GPU. The audit evidence must therefore show that no GPU/Neural Engine compute path, provider or reservation was invoked; do not claim hardware absence unless independently established.

## 7. Converter implementation contract

The converter must be a new, isolated tool (proposed location: `tools/model-build/llama32-coreml/`) with separate 1B and 3B target configuration files. This is a proposed location, not an existing repository path.

It must:
- accept only a verified local source directory and a declared immutable source revision;
- validate the expected upstream file inventory before loading model code;
- load model code in a restricted environment; do not execute arbitrary remote repository code or enable remote-code trust implicitly;
- record all conversion flags, precision choices, deployment target, graph-export method and pass-pipeline settings;
- fail on unsupported operators, unconverted graph nodes, unexpected inputs/outputs, missing state, warnings elevated to errors, or package validation failures;
- never hardcode guessed input/output/state tensor names or shapes;
- never infer attention-mask semantics from a model name or community model card;
- not perform quantization, pruning, weight conversion or tokenizer rewriting unless a separately reviewed profile explicitly specifies it;
- emit a package only into a clean, per-run output directory, never directly into the app's installation directory.

PyTorch graph capture (TorchScript or `torch.export`) and Core ML conversion are candidate mechanisms documented by Apple. The actual choice is a validation decision for the pinned model implementation and toolchain, not a pre-decided assumption. Core ML ML Programs are saved as `.mlpackage`; a compiled `.mlmodelc` is a platform/runtime compilation result and must be recorded separately from the source package.

## 8. Tokenizer binding

The tokenizer is a first-class model dependency, not an interchangeable app utility.

The manifest must bind:
- upstream model identifier and immutable revision;
- tokenizer repository/source identifier and immutable revision;
- hashes and sizes for every tokenizer/config/template/vocabulary/merges asset actually used;
- tokenizer library name and exact version;
- chat-template bytes/hash and selected template identifier, if applicable;
- special-token configuration and normalization behavior as observed from source;
- a compatibility test report proving the loaded tokenizer files correspond to the same declared model revision.

The converter must not silently download a tokenizer during build. It must load only from the verified local input directory. If any expected tokenizer file is missing, extra, changed or sourced from another revision, stop.

## 9. Provenance manifest

Emit UTF-8 canonical JSON (RFC 8785/JCS canonicalization or an equivalently specified deterministic canonicalization) as `zero-model-manifest.json`. The signature covers the exact canonical manifest bytes, not a re-serialized approximation.

Required top-level sections:
- `schema_version`
- `model`: model family, variant, upstream publisher, repository identifier, immutable source revision
- `license`: license identifier, license/AUP/notice file inventory and SHA-256, authorization record reference
- `tokenizer`: source/revision, implementation/version, exact file inventory and hashes
- `toolchain`: runner image identity, OS build, architecture, Xcode/SDK, Swift, Python, PyTorch, CoreMLTools, converter source revision, lockfile SHA-256
- `conversion`: command/profile identifier, declared options, graph capture method, deployment target, precision profile, pass pipeline, timestamps
- `inputs`: exact relative path, byte length and SHA-256 for every model/config/tokenizer/license input
- `outputs`: exact relative path, byte length and SHA-256 for every output package file
- `coreml_evidence`: actual extracted model type, model-description inventory, input/output/state metadata and extraction tool version; absent evidence must be represented as absent and must block readiness
- `validation`: test suite revision, test results, CPU-only execution evidence and report hashes
- `reproducibility`: build identifier, independent rebuild comparison, raw package digest and canonical inventory digest
- `signing`: algorithm, key identifier/fingerprint, signature file path and signer provenance; never private key material

Illustrative shape only (placeholders are deliberately non-values and cannot be accepted by a validator):

```json
{
  "schema_version": 1,
  "model": {
    "publisher": "Meta",
    "model_id": "<exact-official-model-id>",
    "variant": "<1B-or-3B>",
    "source_revision": "<immutable-40-hex-revision>"
  },
  "license": {
    "license_id": "<verified-license-id>",
    "files": []
  },
  "tokenizer": {
    "source_revision": "<same-verified-model-revision>",
    "files": []
  },
  "toolchain": {
    "runner_image": "<immutable-image-identity>",
    "xcode_build": "<exact-build>",
    "python": "<exact-patch-version>",
    "pytorch": "<exact-version>",
    "coremltools": "<exact-version>",
    "lock_sha256": "<64-lowercase-hex>"
  },
  "inputs": [],
  "outputs": [],
  "coreml_evidence": {
    "extracted_from_artifact": true,
    "inputs": [],
    "outputs": [],
    "states": []
  },
  "validation": {
    "cpu_only": true,
    "tests": []
  },
  "signing": {
    "algorithm": "Ed25519",
    "key_id": "<authorized-zero-release-key-id>",
    "signature_file": "zero-model-manifest.sig"
  }
}
```

This example is a schema illustration, not a valid manifest. Angle-bracket placeholders, empty required evidence arrays, unknown revisions and missing signatures must fail validation.

The final import envelope must be adapted to the exact schema and path constraints implemented by `CoreMLArtifactImportStore.swift`. Do not assume the illustrative manifest can be fed directly to the current installer. Schema compatibility must be established by tests before any production import.

## 10. Signing and key custody

- Upstream source authenticity and ZERO artifact release signing are separate trust statements.
- Do not claim an upstream Ed25519 signature exists unless the publisher actually provides a verifiable signature and authenticated public-key distribution.
- A ZERO signature is allowed only after an authorized key custodian supplies an existing approved public-key identity and signing process.
- The private key must remain outside source control, build logs, pull-request workflows and model artifacts.
- The public key must be pinned through an independently reviewed trust-anchor change; no key may be generated or substituted as part of this specification.
- Missing key, unknown key ID, invalid signature, manifest mismatch or revoked signer means reject.
- Signature verification must cover exact manifest bytes and be repeated at install/runtime according to the existing signed-import design.

## 11. Fail-closed acceptance gates

A model target is **not build-approved** unless all applicable gates pass:

| Gate | Required evidence | Failure behavior |
|---|---|---|
| G01 Source identity | Official Meta source + immutable revision | Stop |
| G02 Source integrity | Complete inventory, sizes and SHA-256 | Stop |
| G03 License | Exact license/AUP/notice and documented authorization | Stop |
| G04 Tokenizer binding | Same model revision, complete hashed files, compatibility tests | Stop |
| G05 Toolchain | Exact tool versions, runner/Xcode identity, hash lock | Stop |
| G06 CPU-only isolation | Workflow evidence: no provider, GPU or Neural Engine execution/reservation | Stop |
| G07 Conversion | Reviewed graph capture and successful Core ML conversion | Stop |
| G08 Artifact inventory | Complete package inventory, no symlinks/path collisions/unexpected files | Stop |
| G09 Runtime metadata | Actual Core ML model description and state metadata extracted from artifact | Stop |
| G10 Runtime validation | CPU-only structural/prediction tests and tokenizer tests | Stop |
| G11 Reproducibility | Independent rebuild comparison and documented result | Stop or mark non-bit-reproducible; never claim deterministic bytes |
| G12 ZERO signature | Valid authorized detached signature and trusted key | Stop |
| G13 Installer compatibility | Exact envelope/schema/path tests against current import store | Stop |
| G14 Device evidence | Real physical iPhone load/inference test for the exact signed artifact | Production remains disabled until passed |

No gate can be waived by a model-card statement, a successful synthetic fixture, a successful compile, or a CI green check unrelated to the real model artifact.

## 12. Required CI split

Proposed future workflows (not created here):
1. **Source/provenance validation:** validates declared source revision, license records, tokenizer inventory and hashes without conversion.
2. **CPU-only model build:** consumes only previously verified local inputs and the locked wheelhouse; no secrets, providers or GPU reservations.
3. **Artifact inspection/tests:** extracts actual Core ML metadata and runs structural plus CPU-only tests.
4. **Release signing:** protected, separately approved workflow; no PR-triggered signing.
5. **Device acceptance:** separately records real iPhone test evidence; does not automatically publish or enable the model.

Pull-request CI must never have access to signing secrets. Workflow permissions should be minimal, with `contents: read` for build/test jobs. Artifact upload must be access-controlled, time-limited, and must not expose Meta-licensed weights to unauthorized users.

## 13. Implementation sequence after explicit authorization

1. Approve lawful acquisition and access to official Meta model source files.
2. Select and verify immutable source revisions for both model sizes.
3. Resolve the converter toolchain on the supported Apple Silicon runner; produce and review the complete hash lock.
4. Implement source/license/tokenizer verification only.
5. Implement a converter prototype in an isolated tool directory; no app/runtime changes.
6. Validate graph capture and conversion separately for 1B and 3B.
7. Extract actual Core ML metadata from each resulting artifact; review before updating any production contract.
8. Establish independent rebuild comparison.
9. Obtain the actual authorized ZERO signing trust anchor through the proper key custodian.
10. Add installer compatibility and runtime/device acceptance evidence.
11. Only after all gates pass, propose a separate production-contract change. No automatic enablement, merge or deployment.

## 14. Current disposition

- This specification does not download weights or produce model artifacts.
- No tensor names, shapes, dtypes, state layouts or attention-mask semantics are asserted.
- No signing key is created, selected or changed.
- No provider, GPU or Neural Engine reservation is performed.
- No production model readiness flag is changed.
- PR #123 must remain Draft and unmerged; Issue #71 is out of scope.
- A future implementation must be a separate reviewed change, not an implicit consequence of this document.

## 15. Reference documentation

- Apple Core ML Tools – [PyTorch conversion workflow](https://apple.github.io/coremltools/docs-guides/source/convert-pytorch-workflow.html)
- Apple Core ML Tools – [Convert models to ML Programs](https://apple.github.io/coremltools/docs-guides/source/convert-to-ml-program.html)
- Apple Core ML Tools 8.3 API – [Unified conversion API](https://apple.github.io/coremltools/docs/source/coremltools.converters.convert.html)
- Apple Core ML Tools – [Installing Core ML Tools](https://apple.github.io/coremltools/docs-guides/source/installing-coremltools.html)
- Meta – official Llama 3.2 license and model source documentation must be retained from the exact authorized upstream revision used by a future build.


## 16. Implemented offline source-provenance validator (non-production)

The isolated standard-library-only validator lives at `tools/model-build/llama32-coreml/validate_source_provenance.py`. It remains separate from the synthetic Core ML fixture generator and iOS app/runtime.

### Local-only inputs and execution

The CLI requires three already-local inputs:
- `--root`: existing source-file directory;
- `--manifest`: existing local UTF-8 JSON provenance manifest;
- `--git-repo`: existing local Git clone with the source commit and tree objects already present.

The validator performs no network access and does not fetch, download, install, copy, convert, sign, delete, or modify source files. Its Git subprocess explicitly disables lazy fetch, denies all Git protocols, disables prompts, and disables replacement objects; it invokes only local Git object/config inspection commands against already-present objects. It hashes files by streaming and prints JSON to stdout. Exit code 0 means the local checks passed; exit code 2 means validation failed.

### Revision-to-bytes binding

The validator checks:
- model variant and exact official Meta repository identifier for 1B or 3B;
- local `origin` URL equals the canonical HTTPS Hugging Face URL for that repository (read from local Git config; no remote request);
- the full lowercase 40-character revision resolves to that exact existing Git commit object;
- commit tree is readable and each declared source path is a regular Git blob in that commit;
- each local file matches the bytes of its committed Git blob;
- for Git LFS files, the committed standard LFS pointer's SHA-256 and size match the locally materialized file;
- tokenizer repository and revision exactly equal the model source repository and revision;
- exact local file inventory, declared byte sizes, SHA-256, path safety, symlink rejection, and case/Unicode collision rejection.

The Git clone is not fetched or updated. A missing commit object is a hard failure. A passing check proves only that local files match the selected local commit tree and configured origin string. The origin string is mutable local configuration and is not publisher authentication; a commit hash authenticates object contents, not who published them. No Meta signing key is assumed or fabricated. `publisher_signature_verified` remains false.

### License and AUP content checks

The manifest must explicitly identify `license.license_document` and `license.aup_document`, and both paths must match inventory roles `license` and `aup`. The validator reads the actual local UTF-8 text and requires identity markers:
- Llama Community License: `llama 3.2`, `community license`, and `meta platforms`;
- Acceptable Use Policy: `acceptable use policy` and `meta`.

Both documents must also be present in the exact source commit tree and match the local bytes. These markers catch obvious wrong or placeholder documents but are not proof of official authenticity, completeness, legal sufficiency, or user acceptance. The `license.acceptance_record` remains a recorded reference, not a verified consent receipt. The JSON report exposes `license_acceptance_claimed` and `license_acceptance_reference_present` as manifest declarations only, and always sets `license_acceptance_verified=false`; it does not inspect an authoritative consent receipt. Missing/mismatched content fails closed.

### Explicit limitations

A passing report does not establish:
- upstream publisher authenticity or a Meta signature;
- legal sufficiency of license acceptance;
- correctness of tokenizer semantics or chat template;
- Core ML package validity, model tensor/state metadata, or runtime compatibility;
- any Ed25519 signature or ZERO trust-anchor verification;
- production readiness.

The report always sets `production_approval=false`, `publisher_signature_verified=false`, `signature_verified=false`, and `coreml_artifact_verified=false`. A successful local validation must never populate `LlamaCoreMLModelContract` or enable a model.

### Synthetic test policy

`test_validate_source_provenance.py` creates a temporary synthetic Git repository with a synthetic commit, synthetic model-byte fixture, synthetic LFS pointer, and synthetic license/AUP text. These are not Meta files, not model weights, not actual legal documents, and not provenance evidence. Tests cover local commit existence, origin binding, commit-tree byte equality, Git LFS pointer digest/size binding, license content markers, tokenizer revision mismatch, tampering, undeclared files, path traversal, license rejection, symlinks, wrong repository, case collisions, malformed tokenizer paths, and 1B/3B identity.

Run from the validator directory with `python3 -m unittest -v`. The suite uses only Python's standard library and local Git. The existing general CI `verify` job runs these tests immediately after checkout, before dependency installation or any network-dependent CI steps. The validator test step itself has no provider credentials, GPU reservation, model download, conversion operation, or network access.


## 17. Implemented signed provenance envelope (Batch 46)

The importer now requires provenance evidence inside the exact Ed25519-signed import-manifest payload:

- provenanceJSON carries the complete UTF-8 provenance document as bytes.
- provenanceSHA256 is a lowercase SHA-256 digest of those exact bytes.
- Both fields are covered by the detached signature because they are part of the signed import-manifest JSON.
- Import rejects absent provenance, absent/invalid digest, digest mismatch, missing required sections, wrong model variant, malformed source revision, tokenizer/source revision mismatch, missing license/tokenizer/input/output inventories, incomplete toolchain evidence, missing lock hash, missing Core ML input/output evidence, missing CPU-only validation evidence, or missing Ed25519 signing identity.
- The installer writes the exact verified provenance bytes as provenance.json in the same atomic installation envelope.
- Runtime verification rechecks the signed import manifest, validates its provenance document and digest, and compares the installed provenance.json byte-for-byte with the signed embedded bytes before package verification. Runtime snapshots repeat the same verification after copying.
- The import contract does not infer a real Meta signature, legal acceptance, actual tensor specifications, or production readiness. Synthetic fixtures explicitly label their model/toolchain/license values as test-only and cannot populate LlamaCoreMLModelContract.

The Swift regression suite adds cases for missing provenance, an incorrect provenance digest, model/tokenizer revision disagreement, incomplete toolchain evidence, and post-install provenance-file tampering. The source-revision format check only validates a 40-character hexadecimal revision; publisher authenticity remains a separate evidence gate and is not established by synthetic tests.

Important boundary: The present schema validator checks the required provenance sections and core consistency fields. It is not a full RFC 8785/JCS implementation and does not claim legal sufficiency, upstream publisher authentication, real model metadata, or reproducible conversion. Those gates remain closed until genuine evidence is supplied and independently reviewed.

## 18. Batch 47 provenance-schema completeness audit

The Batch 46 review identified structural gaps in the signed Swift import validator. The validator previously required the top-level `conversion` and `reproducibility` objects but did not inspect their evidence fields; it accepted any non-empty `model_id`; it did not require a separate license-acceptance reference; it did not require Core ML state metadata; and it did not bind the provenance output inventory to the signed package file inventory.

The importer now rejects those gaps before installation and repeats the same validation at runtime:

- **Model identity:** `model_id` must exactly match the official Meta repository identifier for the selected 1B or 3B variant. The source revision and converter revision must be lowercase 40-character hexadecimal identifiers; this does not authenticate Meta as publisher.
- **License declaration:** `accepted` must be explicitly true and `acceptance_record` must be a non-empty reference. These are signed manifest declarations only. The importer does not inspect an authoritative consent receipt and never reports legal consent as verified.
- **Toolchain:** requires Python, PyTorch, CoreMLTools, Xcode build, SDK, Swift, OS build, architecture, runner image, lock SHA-256 and converter source revision. Values are recorded as supplied evidence; non-empty fields and a lock digest do not prove that the environment was immutable or independently reproduced.
- **Conversion:** requires command, profile, graph-capture method, deployment target, precision profile, pass-pipeline description and an options object. The schema does not prescribe or invent conversion values.
- **Core ML evidence:** requires extraction-tool version plus non-empty input, output and state metadata. Every input/output/state metadata record must include a name, data type and shape field. The validator checks structural presence, not the truth of claimed metadata; real values must be extracted from the actual artifact.
- **Inventory binding:** license and tokenizer records must match their path/size/hash records in the provenance input inventory. Provenance outputs must match the signed import manifest's package file inventory exactly.
- **Validation:** each declared CPU-only test must have a name, pass result and SHA-256 report reference.
- **Signer identity:** `signing.key_id` must equal `sha256:<lowercase SHA-256 of the exact 32-byte Ed25519 public key pinned in the signed app bundle>`. The importer checks this binding both before installation and during runtime revalidation; a free-form or substituted key identifier is rejected.
- **Reproducibility:** requires distinct primary/comparison build identifiers, two package SHA-256 values, a canonical inventory SHA-256, a comparison-report SHA-256 and an explicit `identical` or `different` result. The result must agree with the two package hashes. A non-identical rebuild is recorded as different, not silently normalized into a reproducibility claim. Missing independent-build evidence blocks import.

The added Swift synthetic regression cases cover wrong model ID, missing license-acceptance reference, absent and malformed Core ML state metadata, incomplete conversion evidence, absent independent rebuild evidence, output-inventory mismatch and a signer key identifier that does not match the pinned Ed25519 key. The existing fixtures remain explicitly synthetic and do not constitute model, license, toolchain, conversion or reproducibility evidence.

### Toolchain gate disposition after Batch 47

No toolchain pin was changed because no verified immutable replacement evidence was available. The following gates remain open:

1. Python is selected by the `3.12` minor line, not an immutable patch build.
2. CoreMLTools is installed as `8.3.0` without a complete transitive dependency lock and wheel hashes.
3. PyTorch, torchvision, Transformers, safetensors and tokenizer dependencies do not yet have a validated exact version/hash lock.
4. The `macos-15` runner label is mutable; recording the observed runner image is useful evidence but does not pin the future runner image.
5. The exact Xcode/SDK build is observed in CI, not selected from an immutable toolchain image.
6. XcodeGen source revision is pinned, but the produced binary is not yet independently attested by a committed, verified binary digest.
7. No independent clean 1B/3B conversion builds exist, and no genuine Core ML artifact metadata is available.

The native iOS workflow's CoreMLTools installation and synthetic stateful fixture generation are test infrastructure, not a Llama conversion pipeline. Do not resolve these gates by guessing package versions, hashes, Xcode builds or tensor specifications. A future toolchain-lock batch must obtain exact package artifacts and hashes from authoritative package metadata, verify them, and test the complete locked environment before committing pins.

The signed import schema is stricter after this batch, but it remains an evidence-shape and consistency gate. It does not create missing upstream signatures, legal consent receipts, model files, actual tensor metadata, immutable build infrastructure or independent conversion results.
