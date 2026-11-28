# Offline Llama 3.2 source provenance validator

This directory contains a standard-library-only, read-only validator for locally supplied provenance metadata and files. It does not access the network: Git lazy-fetch is disabled and all Git protocols are denied in its subprocess environment. It does not fetch Git objects, download, install, copy, convert, sign, or modify model assets. Git inspection is restricted to an already-existing local clone and its already-present object database. The tool emits a JSON report to stdout only.

## Run

```bash
python3 validate_source_provenance.py \
  --root /path/to/local/source-files \
  --manifest /path/to/local/provenance.json \
  --git-repo /path/to/already-cloned/local-huggingface-repository
```

Exit code 0 means the declared local source inventory, Git commit/tree membership, file bytes, tokenizer revision binding, and license/AUP document markers passed. Exit code 2 means validation failed.

## Checks

- exact official Meta model repository identifier for the declared 1B/3B variant;
- canonical local Git origin URL for that repository, read from local Git config only;
- full 40-character revision resolves to an existing commit object in the local object database;
- every declared source path is a regular file in that exact commit tree;
- local file bytes match the commit blob, or (for Git LFS) the committed LFS pointer's SHA-256 and size;
- exact local file inventory, byte length, SHA-256, tokenizer repository/revision binding;
- license and AUP paths are explicitly identified and their text contains required Llama Community License / Meta Acceptable Use Policy identity markers;
- no symlinks, path traversal, Unicode/case collisions or undeclared files.

## Trust boundary

A passing report is **not** an upstream signature verification, cryptographic proof that Meta published the local Git remote, a legal opinion, proof that an account holder accepted the license, Core ML artifact verification, or production approval. A local Git remote URL is configurable metadata; a Git commit hash authenticates object contents only relative to the object ID and does not authenticate its publisher. The validator intentionally does not invent or pin an upstream public key. Publisher signature status is always reported as false. The JSON report distinguishes a manifest claim (`license_acceptance_claimed`) and a non-empty reference (`license_acceptance_reference_present`) from verified consent; `license_acceptance_verified` is always false because this tool does not inspect an authoritative consent receipt.

The license marker checks detect obvious wrong/placeholder documents; they do not prove the documents are authentic or complete. `license.acceptance_record` is a recorded reference, not a verified consent receipt. Production approval, signature verification, and Core ML artifact verification always remain false.

## Tests

```bash
python3 -m unittest -v
```

All test assets and the local Git repository are generated synthetically in temporary directories. The synthetic weights bytes are not model weights; the synthetic license/AUP text is not official legal text; the synthetic commit is not a Meta commit. Tests require only Python's standard library and a local Git executable. No test accesses the network.
