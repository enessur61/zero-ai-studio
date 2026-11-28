#!/usr/bin/env python3
"""Offline, read-only validator for local Llama 3.2 source provenance.

No network access, downloads, installation, conversion, signing, or file writes.
Git inspection is restricted to an already-local repository and existing objects.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit

MODEL_REPOSITORIES = {
    "1B": "meta-llama/Llama-3.2-1B-Instruct",
    "3B": "meta-llama/Llama-3.2-3B-Instruct",
}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
LFS_POINTER_RE = re.compile(
    rb"\Aversion https://git-lfs\.github\.com/spec/v1\n"
    rb"oid sha256:([0-9a-f]{64})\n"
    rb"size ([0-9]+)\n?\Z"
)
REQUIRED_ROLES = {"model_weights", "model_config", "tokenizer", "license", "aup"}
LICENSE_MARKERS = ("llama 3.2", "community license", "meta platforms")
AUP_MARKERS = ("acceptable use policy", "meta")


class ValidationError(ValueError):
    """Raised when source provenance cannot be established."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def _safe_relative_path(raw: Any) -> str:
    _require(isinstance(raw, str) and raw, "File path must be a non-empty string.")
    _require("\\" not in raw and "\x00" not in raw,
             f"Unsafe file path: {raw!r}")
    _require(not any(ord(char) < 32 or ord(char) == 127 for char in raw),
             f"Control characters are forbidden in paths: {raw!r}")
    path = PurePosixPath(raw)
    _require(not path.is_absolute(), f"Absolute path is forbidden: {raw!r}")
    parts = raw.split("/")
    _require(all(part not in ("", ".", "..", ".git") for part in parts),
             f"Path traversal or reserved path component: {raw!r}")
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


def _git(repo: Path, *args: str) -> bytes:
    """Run a local Git object/config inspection; never fetch or contact a remote."""
    env = os.environ.copy()
    env.update({
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_NO_LAZY_FETCH": "1",
        "GIT_ALLOW_PROTOCOL": "",
    })
    command = ["git", "--no-replace-objects", "-C", str(repo), *args]
    try:
        result = subprocess.run(
            command, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValidationError(f"Local Git inspection failed: {exc}") from exc
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise ValidationError(f"Local Git command failed ({' '.join(args[:2])}): {detail}")
    return result.stdout


def _expected_remote_url(repository: str) -> str:
    return f"https://huggingface.co/{repository}"


def _verify_local_git_revision(
    git_repo: Path, revision: str, expected_repository: str
) -> tuple[dict[str, tuple[str, str]], str]:
    _require(git_repo.exists() and git_repo.is_dir() and not git_repo.is_symlink(),
             "git_repo must be an existing local directory, not a symlink.")
    git_repo = git_repo.resolve(strict=True)

    remote_raw = _git(git_repo, "config", "--local", "--get", "remote.origin.url")
    try:
        remote = remote_raw.decode("utf-8").strip()
    except UnicodeError as exc:
        raise ValidationError("Local origin URL is not UTF-8.") from exc

    expected = _expected_remote_url(expected_repository)
    _require(remote.rstrip("/") in {expected, expected + ".git"},
             f"Local origin URL must be {expected!r}; got {remote!r}.")
    parsed = urlsplit(remote)
    _require(parsed.scheme == "https" and parsed.netloc == "huggingface.co"
             and parsed.username is None and parsed.password is None,
             "Only the canonical HTTPS Hugging Face origin is accepted.")

    resolved = _git(git_repo, "rev-parse", "--verify", f"{revision}^{{commit}}")
    resolved_revision = resolved.decode("ascii").strip()
    _require(resolved_revision == revision,
             "Requested source revision did not resolve to the exact commit object.")
    object_type = _git(git_repo, "cat-file", "-t", revision).decode("ascii").strip()
    _require(object_type == "commit", "Source revision does not identify a Git commit.")

    tree_sha = _git(git_repo, "rev-parse", "--verify", f"{revision}^{{tree}}")
    tree_id = tree_sha.decode("ascii").strip()
    tree_entries_raw = _git(git_repo, "ls-tree", "-r", "-z", "--full-tree", revision)
    tree_entries: dict[str, tuple[str, str]] = {}
    for raw_entry in tree_entries_raw.split(b"\x00"):
        if not raw_entry:
            continue
        try:
            metadata, raw_path = raw_entry.split(b"\t", 1)
            mode, kind, object_id = metadata.decode("ascii").split(" ", 2)
            path = raw_path.decode("utf-8")
        except (ValueError, UnicodeError) as exc:
            raise ValidationError("Git tree contains an unsupported or non-UTF-8 path.") from exc
        _require(path not in tree_entries, f"Duplicate path in Git tree: {path!r}")
        tree_entries[path] = (mode, kind)
        # Keep the object ID separately encoded in the temporary key below.
        tree_entries[path + "\x00" + object_id] = (mode, kind)

    return tree_entries, tree_id


def _tree_blob(tree_entries: dict[str, tuple[str, str]], path: str) -> str:
    matches = [key for key in tree_entries if key.startswith(path + "\x00")]
    _require(len(matches) == 1, f"File is absent or ambiguous in source commit tree: {path}")
    object_id = matches[0].split("\x00", 1)[1]
    mode, kind = tree_entries[matches[0]]
    _require(kind == "blob" and mode in {"100644", "100755"},
             f"Git source path is not a regular file: {path}")
    return object_id


def _check_git_blob_against_local(
    git_repo: Path,
    tree_entries: dict[str, tuple[str, str]],
    revision: str,
    rel: str,
    local_path: Path,
    local_size: int,
    local_sha256: str,
) -> str:
    object_id = _tree_blob(tree_entries, rel)
    blob = _git(git_repo, "cat-file", "blob", object_id)
    lfs = LFS_POINTER_RE.fullmatch(blob)
    if lfs:
        pointer_sha = lfs.group(1).decode("ascii")
        pointer_size = int(lfs.group(2))
        _require(pointer_sha == local_sha256 and pointer_size == local_size,
                 f"Materialized Git LFS file does not match its committed pointer: {rel}")
        return "git-lfs-content-digest-matched"
    git_blob_sha = hashlib.sha256(blob).hexdigest()
    _require(len(blob) == local_size and git_blob_sha == local_sha256,
             f"Local file bytes do not match the source commit blob: {rel}")
    return "git-blob-bytes-matched"


def _verify_license_text(root: Path, license_data: dict[str, Any],
                         declared: dict[str, dict[str, Any]]) -> None:
    license_path = _safe_relative_path(license_data.get("license_document"))
    aup_path = _safe_relative_path(license_data.get("aup_document"))
    _require(license_path in declared and declared[license_path]["role"] == "license",
             "license.license_document must reference an inventory file with role=license.")
    _require(aup_path in declared and declared[aup_path]["role"] == "aup",
             "license.aup_document must reference an inventory file with role=aup.")
    for label, rel, markers in (
        ("Llama Community License", license_path, LICENSE_MARKERS),
        ("Acceptable Use Policy", aup_path, AUP_MARKERS),
    ):
        try:
            text = (root / rel).read_text(encoding="utf-8").casefold()
        except (OSError, UnicodeError) as exc:
            raise ValidationError(f"{label} must be readable UTF-8 text: {rel}") from exc
        _require(all(marker in text for marker in markers),
                 f"{label} content does not contain all required identity markers: {rel}")
        _require(not any(marker in text for marker in ("synthetic fixture", "placeholder document")),
                 f"{label} contains a known placeholder marker: {rel}")


def validate(root: Path, manifest_path: Path, git_repo: Path) -> dict[str, Any]:
    """Validate local metadata, source commit tree, exact bytes and license documents."""
    _require(root.exists() and root.is_dir() and not root.is_symlink(),
             "Source root must be an existing directory and not a symlink.")
    root = root.resolve(strict=True)
    manifest = _read_manifest(manifest_path)

    _require(type(manifest.get("schema_version")) is int and manifest.get("schema_version") == 1,
             "Unsupported schema_version.")
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
    _require(isinstance(variant, str) and variant in MODEL_REPOSITORIES,
             "model.variant must be 1B or 3B.")
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
        _require(key not in folded,
                 f"Case/Unicode path collision: {rel!r} and {folded.get(key)!r}")
        folded[key] = rel
        _require(rel not in declared, f"Duplicate file entry: {rel}")
        role = entry.get("role")
        _require(isinstance(role, str) and role in REQUIRED_ROLES,
                 f"Unsupported file role for {rel!r}.")
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
    _require(set(normalized_tokenizer) ==
             {p for p, entry in declared.items() if entry["role"] == "tokenizer"},
             "tokenizer.files must exactly match files with role=tokenizer.")
    _require(set(normalized_license) ==
             {p for p, entry in declared.items() if entry["role"] in {"license", "aup"}},
             "license.files must exactly match license and AUP inventory entries.")

    tree_entries, tree_id = _verify_local_git_revision(git_repo, revision, expected_repo)
    git_checks: dict[str, str] = {}
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
        actual_sha = digest.hexdigest()
        _require(actual_sha == entry["sha256"], f"SHA-256 mismatch for {rel}")
        git_checks[rel] = _check_git_blob_against_local(
            git_repo, tree_entries, revision, rel, candidate, stat_size, actual_sha
        )

    actual: set[str] = set()
    for path in root.rglob("*"):
        _require(not path.is_symlink(), f"Symlink in source tree: {path.relative_to(root)}")
        if path.is_file():
            actual.add(path.relative_to(root).as_posix())
    _require(actual == set(declared),
             f"Source inventory mismatch; undeclared={sorted(actual - set(declared))}, "
             f"missing={sorted(set(declared) - actual)}")

    _verify_license_text(root, license_data, declared)

    return {
        "valid": True,
        "mode": "offline-read-only",
        "model_id": expected_repo,
        "variant": variant,
        "source_revision": revision,
        "git_commit_object_verified": True,
        "git_tree_id": tree_id,
        "git_origin_matches_official_repository": True,
        "git_file_content_checks": git_checks,
        "files_checked": len(declared),
        "roles_checked": sorted(roles),
        "tokenizer_revision_matches_source": True,
        "license_document_markers_verified": True,
        "aup_document_markers_verified": True,
        "license_acceptance_claimed": True,
        "license_acceptance_reference_present": True,
        "license_acceptance_verified": False,
        "publisher_signature_verified": False,
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
    parser.add_argument("--git-repo", required=True, type=Path,
                        help="Existing local Git clone with source commit objects; never fetched.")
    args = parser.parse_args()
    try:
        report = validate(args.root, args.manifest, args.git_repo)
    except (ValidationError, OSError) as exc:
        print(json.dumps({"valid": False, "error": str(exc),
                          "production_approval": False}, sort_keys=True))
        return 2
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
