# Offline Llama 3.2 source provenance validator

This directory contains a read-only validator for locally supplied provenance metadata and files. It does not download, install, copy, convert, sign, or modify model assets. It emits a JSON report to stdout only.

## Run

```bash
python3 validate_source_provenance.py --root /path/to/local/source --manifest /path/to/provenance.json
```

Exit code 0 means the declared local source inventory, hashes, source identity, tokenizer revision binding, and license/AUP records passed. Exit code 2 means validation failed.

The manifest schema is described in `docs/architecture/LLAMA32_COREML_BUILD_SPEC.md` and enforced by the validator:
- exact official Meta model repository for the declared 1B/3B variant;
- immutable 40-character source revision;
- tokenizer repository and revision exactly equal to model source;
- explicit license acceptance record and both license and AUP files;
- exact file inventory with byte length, SHA-256 and one of the required roles;
- no symlinks, path traversal, Unicode/case collisions or undeclared files.

A passing report is **not** an upstream signature verification, Core ML artifact verification, license legal opinion, or production approval. The tool does not verify that a supplied acceptance record is truthful; it verifies only that the local manifest records one. Upstream authenticity must be established separately.

## Tests

```bash
python3 -m unittest -v
```

All test assets are synthetic byte strings, explicitly not model weights or official license documents. Tests use only the Python standard library.
