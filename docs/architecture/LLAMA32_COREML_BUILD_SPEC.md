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


## 19. Batch 48 observed toolchain evidence (2026-11-28)

This section records only facts observed in the completed CI logs and authoritative package metadata. It is an audit snapshot, not an approved Llama conversion lock.

### 19.1 Native CI execution snapshot

Source: Native iOS workflow run `46166896060`, job `141046320077`, PR head `45a8c89db6a27d32cffc13a067e4ea40a4f8ffde`.

| Component | Exact observed evidence | Gate assessment |
|---|---|---|
| Runner label | Workflow requests `macos-15`; actual image reported `macos-15-arm64` | Mutable label; not a future immutable pin |
| Runner image | `20261123.0558.1`; image release `macos-15-arm64/20261123.0558` | Exact for this run only; image version is logged, not selected in workflow |
| OS | Runner image release reports macOS `15.8.2 (24H232)` | Snapshot only |
| Architecture | Native `arm64` | Observed |
| Python | CPython `3.12.10`, arm64 | Exact resolved version in this run; workflow still asks for `3.12`, so next run can resolve differently |
| Xcode | `16.4 (16F6)`; `XCODE_PRODUCT_BUILD_VERSION=16F6` and `--xcode-version 16F6` appear in build logs | Exact observed build; workflow does not enforce it as a pin |
| iOS SDK | iOS `18.5 (22F76)` for simulator and device builds | Exact observed SDK build; workflow does not enforce it as a pin |
| Swift | `swift-driver 1.120.5` | Driver version observed; full `swift --version` output/build identity not emitted |
| XcodeGen | `2.46.0`; source commit `8445e778451c7e44237b90281bde622d764b0084` | Source revision and reported version pinned; executable SHA-256 not emitted |
| XcodeGen cache | This run restored a cache hit for the source-commit/toolchain-derived cache key | Cache hit does not independently prove cached binary bytes were built from the stated source revision |
| CoreMLTools | `8.3.0`; wheel tag `cp312-none-macosx_11_0_arm64` | Exact package artifact observed for this run; not yet installed through a hash-enforced lock |

The runner image release record is published at https://github.com/actions/runner-images/releases/tag/macos-15-arm64%2F20261123.0558. It identifies image version `20261123.0558.1` and macOS `15.8.2 (24H232)`. The workflow still uses the mutable `macos-15` label.

The Xcode 16.4 build identifier `16F6` is present in the generated build command arguments and `XCODE_PRODUCT_BUILD_VERSION`; the SDK version/build `iOS 18.5 (22F76)` is present in the SDK path and SDK stat-cache name. These are exact observed values for this run, but the workflow does not enforce them as fixed requirements, and no SDK/Xcode package digest is retained. The workflow currently computes a short cache-key prefix from `xcodebuild -version` and `swift --version`, but does not print or retain those full outputs as build provenance.

### 19.2 CoreMLTools wheel evidence

The actual install log records the macOS ARM64 CPython 3.12 wheel:

- Filename: `coremltools-8.3.0-cp312-none-macosx_11_0_arm64.whl`
- Package version: `8.3.0`
- Official PyPI SHA-256: `e8a70ca3b34676cbcb61f70e1192593062eb85a9a64e29e03268d6f280b2c86e`
- Official release file metadata: https://pypi.org/project/coremltools/8.3.0/

This hash is a verified package-file checksum from the PyPI release metadata. It is recorded as candidate artifact evidence only; it is **not** yet a committed lock entry and does not establish that CoreMLTools 8.3.0 is compatible with a real Llama conversion graph. The native fixture CI did successfully install and execute this package for the synthetic stateful fixture.

### 19.3 Resolved packages observed in the fixture environment

The completed job log records the following exact resolved versions for the CoreMLTools fixture environment:

| Package | Observed version | Wheel SHA-256 in committed lock |
|---|---:|---|
| coremltools | 8.3.0 | No committed lock; candidate wheel checksum recorded above |
| numpy | 2.5.5 | Missing |
| protobuf | 7.36.2 | Missing |
| sympy | 1.14.0 | Missing |
| tqdm | 4.70.1 | Missing |
| packaging | 26.4 | Missing |
| attrs | 26.1.0 | Missing |
| cattrs | 26.2.1 | Missing |
| pyaml | 26.7.0 | Missing |
| PyYAML | 6.0.4 | Missing |
| mpmath | 1.3.0 | Missing |
| typing-extensions | 4.16.0 | Missing |

These are observed resolver results from one run, not approved compatibility pins. The workflow installs CoreMLTools with an unconstrained transitive resolver and does not use `pip --require-hashes`. No dependency wheel hashes are committed.

### 19.4 Llama conversion dependencies not established

The inspected native workflow does not install or exercise PyTorch, Transformers, safetensors or the Hugging Face `tokenizers` package for Llama conversion. The synthetic fixture uses CoreMLTools MIL builders directly and is not evidence of a PyTorch-to-Core-ML Llama conversion path.

Accordingly, no exact PyTorch, Transformers, safetensors or tokenizers version is selected in this audit. No wheel SHA-256 for those packages is accepted as a ZERO pin. Picking a currently available PyPI release without validating the complete converter graph, Python ABI, Apple Silicon wheel availability and transitive constraints would be guesswork and is explicitly rejected.

### 19.5 XcodeGen binary provenance gap

The workflow pins XcodeGen source commit `8445e778451c7e44237b90281bde622d764b0084`, builds from that revision on a cache miss, and checks that the executable reports version `2.46.0`. The current run restored a pre-existing cache hit, and the workflow does not calculate, emit, compare or retain the executable's SHA-256. Thus:

- source revision is pinned;
- reported version is checked;
- executable content identity is **not** independently verified;
- cache provenance is not cryptographically attested.

Do not convert the Git source commit into an assumed binary hash. A future fix must either build from the pinned source on every clean toolchain image or validate a reviewed, independently produced binary digest and emit the actual digest in CI.

### 19.6 Batch 48 disposition

No package versions or hashes were added to the production conversion lock because a complete, tested dependency set does not yet exist. The only newly verified wheel checksum is the CoreMLTools 8.3.0 ARM64 wheel checksum above. Remaining hard blockers:

1. Select and test a compatible exact PyTorch release and its actual macOS ARM64 wheel.
2. Select and test exact Transformers, safetensors and tokenizer dependencies against that PyTorch/CoreMLTools combination.
3. Resolve every transitive package and record hashes for every accepted wheel/sdist; enforce `pip --require-hashes`.
4. Pin CPython 3.12.10 (or a separately validated exact patch) and attest the interpreter distribution/build; the current workflow still requests only `3.12`.
5. Enforce the observed Xcode build `16F6` and iOS SDK build `18.5 (22F76)` as explicit workflow requirements, and retain full toolchain output/digests; current workflow merely runs with whatever the mutable image supplies.
6. Make runner image selection immutable or document and approve the exact image version for each release build.
7. Emit and verify XcodeGen executable SHA-256 and close the cache-origin ambiguity.
8. Build and compare real Llama 1B and 3B conversion outputs in two independent clean builds before claiming artifact reproducibility.

No model weights were downloaded, no Llama conversion was run, no model artifacts or tensor contracts were created, and no signing key was introduced in Batch 48. The existing fail-closed production posture remains mandatory.


## 20. Batch 49 – Candidate Python conversion stack (metadata audit only)

This is a candidate matrix for a later isolated dependency-resolution and compatibility job. It is **not** an approved lock, and no package was downloaded or installed as part of this audit. SHA-256 values below are the official PyPI release-file checksums for the exact macOS ARM64 / CPython 3.12-compatible wheel where one exists. A checksum authenticates bytes against PyPI metadata; it does not by itself prove the publisher or validate the converter combination.

### 20.1 Candidate direct wheels

| Package | Candidate version | Exact compatible wheel | PyPI SHA-256 | Release provenance | Status |
|---|---:|---|---|---|---|
| CoreMLTools | 9.0 | `coremltools-9.0-cp312-none-macosx_11_0_arm64.whl` | `7079e8b6ff5a63f0e2c08eeeb8673e4eab8ca231d4b2eae4f7fb005e0d08a8cd` | PyPI page reports no Trusted Publishing provenance | Candidate |
| PyTorch | 2.7.1 | `torch-2.7.1-cp312-none-macosx_11_0_arm64.whl` | `787687087412c4bd68d315e39bc1223f08aae1d16a9e9771d95eabbb04ae98fb` | PyPI page reports no Trusted Publishing provenance | Candidate |
| Transformers | 5.24.1 | `transformers-5.24.1-py3-none-any.whl` | `505b39d3e45a3715f3acb81b858eb245ce1a462373b7f99e26f0dcd41ed4cd0f` | PyPI Trusted Publishing attestation present | Candidate |
| safetensors | 0.8.0 | `safetensors-0.8.0-cp310-abi3-macosx_11_0_arm64.whl` | `c80201d22cbf405b80647a60ada77bba06c8fba2da2743ba1e89cdcc39a81f25` | PyPI page reports no Trusted Publishing provenance | Candidate |
| tokenizers | 0.23.3 | `tokenizers-0.23.3-cp310-abi3-macosx_11_0_arm64.whl` | `68649e97d5b43c44c031d8d848874a6eecae8f8fe40ea989aa777a5a83aca716` | PyPI Trusted Publishing attestation present | Candidate |

The `cp310-abi3` safetensors and tokenizers wheels declare the stable CPython limited ABI and are tagged for macOS 11+ ARM64; they are compatible at wheel-tag level with CPython 3.12. This is a packaging compatibility statement, not an end-to-end import or conversion test.

### 20.2 Why this is a coherent candidate, not yet a proven toolchain

- CoreMLTools 9.0 release notes explicitly add PyTorch 2.7 support. The exact 9.0 CPython 3.12 ARM64 wheel exists on PyPI.
- PyTorch 2.7.1 publishes an exact CPython 3.12 macOS ARM64 wheel.
- Transformers 5.24.1 declares Python 3.11+ and PyTorch 2.6+ in its installation requirements; PyTorch 2.7.1 satisfies that declared minimum.
- safetensors 0.8.0 and tokenizers 0.23.3 declare Python >=3.10 and publish macOS ARM64 `abi3` wheels.
- Apple documents PyTorch graph capture via `torch.jit.trace` or `torch.export`, followed by the CoreMLTools Unified Conversion API. This establishes the supported integration path, not successful conversion of Llama 3.2.

These facts support trying the candidate combination in an isolated resolver/import test. They do **not** establish that the real Llama 3.2 graph, its attention/cache operators, dynamic shapes, or state representation convert successfully. No model-specific compatibility claim is made.

### 20.3 Exact artifacts and source records

- CoreMLTools 9.0 PyPI release: https://pypi.org/project/coremltools/9.0/
- CoreMLTools 9.0 signed GitHub release notes and PyTorch 2.7 support statement: https://github.com/apple/coremltools/releases/tag/9.0
- PyTorch 2.7.1 PyPI release: https://pypi.org/project/torch/2.7.1/
- Transformers 5.24.1 PyPI release and Trusted Publishing provenance: https://pypi.org/project/transformers/5.24.1/
- safetensors 0.8.0 PyPI release: https://pypi.org/project/safetensors/0.8.0/
- tokenizers 0.23.3 PyPI release and provenance: https://pypi.org/project/tokenizers/0.23.3/
- Apple PyTorch conversion workflow: https://apple.github.io/coremltools/docs-guides/source/convert-pytorch-workflow.html
- Python 3.12.10 release: https://www.python.org/downloads/release/python-31210/

### 20.4 Python runtime artifact gap

The native CI observed CPython 3.12.10 ARM64, but workflow configuration still requests only `3.12`. Python.org's 3.12.10 release page exposes the macOS universal2 installer and signature material, but the inspected release page does not expose a SHA-256 checksum for that installer (it lists MD5). Therefore the CPython runtime is not yet a hash-pinned artifact. Batch 49 must select a verifiable interpreter distribution with a SHA-256/Sigstore verification path, or explicitly retain this as an open gate; do not treat the CI version string as binary provenance.

### 20.5 Remaining Batch 49 work before a lock can be approved

1. Run a no-model-download resolver audit for the five candidate packages on CPython 3.12 / macOS ARM64; capture the full dependency graph and all selected wheel filenames.
2. Reject any sdist or platform-mismatched wheel unless a separately reviewed, reproducible source-build process is provided.
3. Record PyPI SHA-256 for every transitive wheel and enforce `pip --require-hashes`; keep provenance-attestation status distinct from checksum status.
4. Verify import/runtime compatibility of `torch`, `coremltools`, `transformers`, `safetensors` and `tokenizers` in the same clean environment. Do not fetch a model or invoke a converter in this stage.
5. Check the installed Transformers Llama 3.2 configuration/model classes and tokenizer APIs without downloading model weights; do not infer actual tensor I/O contracts from config classes.
6. Reconcile CoreMLTools 9.0's PyTorch 2.7 support with the exact selected torch wheel and all transitive NumPy/protobuf constraints.
7. Pin and attest CPython 3.12.10, Xcode 16.4 build `16F6`, iOS SDK `18.5 (22F76)`, and runner image `20261123.0558.1`; these are currently observed but not all enforced.
8. Build XcodeGen from its pinned source revision on a clean cache miss and emit/verify the actual executable SHA-256; a cache hit is not binary provenance.
9. Only after these non-model checks pass, freeze a candidate lock. Actual Llama conversion, model artifact creation and independent reproducibility builds remain separately gated and are prohibited in this batch.

No Python package was downloaded or installed, no model weights or tokenizer assets were fetched, and no conversion or GPU/provider operation was run while preparing this candidate matrix.
