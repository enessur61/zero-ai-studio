#!/usr/bin/env python3
"""Offline, read-only validator for locally supplied Llama 3.2 source provenance.

This tool never downloads, installs, converts, copies, or modifies model files.
It hashes files in place and writes its JSON report only to stdout.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Any

MODEL_REPOSITORIES = {
    "1B": "meta-llama/Llama-3.2-1B-Instruct",
    "3B": "meta-llama/Llama-3.2-3B-Instruct",
}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
REQUIRED_ROLES = {"model_weights", "model_config", "tokenizer", "license", "aup"}


class ValidationError(ValueError):
    """Raised when source provenance cannot be established."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def _safe_relative_path(raw: Any) -> str:
    _require(isinstance(raw, str) and raw, "File path must be a non-empty string.")
    _require("\\" not in raw and "\x00" not in raw, f"Unsafe file path: {raw!r}")
    path = PurePosixPath(raw)
    _require(not path.is_absolute(), f"Absolute path is forbidden: {raw!r}")
    _require(all(part not in ("", ".", "..") for part in raw.split("/")),
             f"Path traversal or non-canonical path: {raw!r}")
    _require(str(path) == raw, f"Non-canonical path: {raw!r}")
    return raw


def _read_manifest(path: Path) -> dict[str, Any]:
    _require(path.is_file() and not path.is_symlink(),
             "Manifest must be an existing regular, non-symlink file.")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValidationError(f"Cannot read JSON manifest: {exc}") from exc
    _require(isinstance(value, dict), "Manifest root must be a JSON object.")
    return value


def validate(root: Path, manifest_path: Path) -> dict[str, Any]:
    """Validate metadata and exact local inventory without changing the filesystem."""
    _require(root.exists() and root.is_dir() and not root.is_symlink(),
             "Source root must be an existing directory and not a symlink.")
    root = root.resolve(strict=True)
    manifest = _read_manifest(manifest_path)

    _require(manifest.get("schema_version") == 1, "Unsupported schema_version.")
    model = manifest.get("model")
    source = manifest.get("source")
    tokenizer = manifest.get("tokenizer")
    license_data = manifest.get("license")
    files = manifest.get("files")
    for name, value in (("model", model), ("source", source),
                        ("tokenizer", tokenizer), ("license", license_data)):
        _require(isinstance(value, dict), f"{name} must be an object.")
    _require(isinstance(files, list) and files, "files must be a non-empty array.")

    variant = model.get("variant")
    _require(variant in MODEL_REPOSITORIES, "model.variant must be 1B or 3B.")
    expected_repo = MODEL_REPOSITORIES[variant]
    _require(model.get("publisher") == "Meta", "Only Meta is accepted as publisher.")
    _require(model.get("model_id") == expected_repo,
             "model_id does not match the official repository for this variant.")
    _require(source.get("repository") == expected_repo,
             "Source repository is not the expected official Meta repository.")
    revision = source.get("revision")
    _require(isinstance(revision, str) and REVISION_RE.fullmatch(revision) is not None,
             "Source revision must be an immutable 40-character lowercase Git SHA.")

    _require(tokenizer.get("repository") == expected_repo,
             "Tokenizer repository must match the model repository.")
    _require(tokenizer.get("revision") == revision,
             "Tokenizer revision must exactly match the model source revision.")
    tokenizer_paths = tokenizer.get("files")
    license_paths = license_data.get("files")
    _require(isinstance(tokenizer_paths, list) and tokenizer_paths,
             "tokenizer.files must be a non-empty array.")
    _require(isinstance(license_paths, list) and license_paths,
             "license.files must be a non-empty array.")
    _require(license_data.get("accepted") is True,
             "License acceptance must be explicitly recorded as accepted.")
    acceptance_ref = license_data.get("acceptance_record")
    _require(isinstance(acceptance_ref, str) and acceptance_ref.strip(),
             "A non-empty license acceptance_record reference is required.")

    declared: dict[str, dict[str, Any]] = {}
    folded: dict[str, str] = {}
    for entry in files:
        _require(isinstance(entry, dict), "Every files entry must be an object.")
        rel = _safe_relative_path(entry.get("path"))
        key = unicodedata.normalize("NFC", rel).casefold()
        _require(key not in folded, f"Case/Unicode path collision: {rel!r} and {folded.get(key)!r}")
        folded[key] = rel
        _require(rel not in declared, f"Duplicate file entry: {rel}")
        role = entry.get("role")
        _require(role in REQUIRED_ROLES, f"Unsupported file role for {rel!r}.")
        size = entry.get("size_bytes")
        _require(isinstance(size, int) and not isinstance(size, bool) and size >= 0,
                 f"Invalid size_bytes for {rel!r}.")
        digest = entry.get("sha256")
        _require(isinstance(digest, str) and SHA256_RE.fullmatch(digest) is not None,
                 f"Invalid SHA-256 for {rel!r}.")
        declared[rel] = entry

    roles = {entry["role"] for entry in declared.values()}
    _require(REQUIRED_ROLES.issubset(roles),
             "Inventory must include weights, model config, tokenizer, license and AUP roles.")
    _require(all(isinstance(p, str) for p in tokenizer_paths),
             "Tokenizer file paths must be strings.")
    _require(all(isinstance(p, str) for p in license_paths),
             "License file paths must be strings.")
    normalized_tokenizer = [_safe_relative_path(p) for p in tokenizer_paths]
    normalized_license = [_safe_relative_path(p) for p in license_paths]
    _require(len(normalized_tokenizer) == len(set(normalized_tokenizer)),
             "Duplicate tokenizer file path.")
    _require(len(normalized_license) == len(set(normalized_license)),
             "Duplicate license file path.")
    declared_tokenizer = set(normalized_tokenizer)
    actual_tokenizer = {p for p, entry in declared.items() if entry["role"] == "tokenizer"}
    _require(declared_tokenizer == actual_tokenizer,
             "tokenizer.files must exactly match files with role=tokenizer.")
    declared_license = set(normalized_license)
    actual_license = {p for p, entry in declared.items()
                      if entry["role"] in {"license", "aup"}}
    _require(declared_license == actual_license,
             "license.files must exactly match license and AUP inventory entries.")

    for rel, entry in declared.items():
        candidate = root.joinpath(*PurePosixPath(rel).parts)
        current = root
        for part in PurePosixPath(rel).parts:
            current = current / part
            _require(not current.is_symlink(), f"Symlink is forbidden: {rel}")
        _require(candidate.is_file(), f"Declared file is missing or not regular: {rel}")
        resolved = candidate.resolve(strict=True)
        _require(resolved.is_relative_to(root), f"File escapes source root: {rel}")
        stat_size = candidate.stat().st_size
        _require(stat_size == entry["size_bytes"],
                 f"File size mismatch for {rel}: expected {entry['size_bytes']}, got {stat_size}")
        digest = hashlib.sha256()
        with candidate.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        _require(digest.hexdigest() == entry["sha256"],
                 f"SHA-256 mismatch for {rel}")

    actual: set[str] = set()
    for path in root.rglob("*"):
        _require(not path.is_symlink(), f"Symlink in source tree: {path.relative_to(root)}")
        if path.is_file():
            actual.add(path.relative_to(root).as_posix())
    _require(actual == set(declared),
             f"Source inventory mismatch; undeclared={sorted(actual - set(declared))}, "
             f"missing={sorted(set(declared) - actual)}")

    return {
        "valid": True,
        "mode": "offline-read-only",
        "model_id": expected_repo,
        "variant": variant,
        "source_revision": revision,
        "files_checked": len(declared),
        "roles_checked": sorted(roles),
        "tokenizer_revision_matches_source": True,
        "license_acceptance_recorded": True,
        "production_approval": False,
        "signature_verified": False,
        "coreml_artifact_verified": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path,
                        help="Existing local directory containing only declared source files.")
    parser.add_argument("--manifest", required=True, type=Path,
                        help="Local JSON provenance manifest; never fetched from a URL.")
    args = parser.parse_args()
    try:
        report = validate(args.root, args.manifest)
    except (ValidationError, OSError) as exc:
        print(json.dumps({"valid": False, "error": str(exc),
                          "production_approval": False}, sort_keys=True))
        return 2
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
