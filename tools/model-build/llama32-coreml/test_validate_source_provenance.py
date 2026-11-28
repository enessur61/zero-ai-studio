"""Synthetic-only tests; all files and Git objects are generated in temp dirs."""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from validate_source_provenance import ValidationError, validate


class ProvenanceValidatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / "source"
        self.root.mkdir()
        self.git_repo = self.base / "local-huggingface-clone"
        self.manifest_path = self.base / "manifest.json"
        self.payloads = {
            "weights/model.safetensors": b"SYNTHETIC TEST BYTES - NOT MODEL WEIGHTS",
            "config/config.json": b'{"synthetic_fixture":true}',
            "tokenizer/tokenizer.json": b'{"synthetic_fixture":true}',
            "license/LICENSE.txt": (
                b"LLAMA 3.2 COMMUNITY LICENSE AGREEMENT\n"
                b"Meta Platforms, Inc.\nSynthetic test document content.\n"
            ),
            "license/USE_POLICY.md": (
                b"Meta Acceptable Use Policy\nSynthetic test document content.\n"
            ),
        }
        self.manifest = {
            "schema_version": 1,
            "model": {
                "publisher": "Meta",
                "model_id": "meta-llama/Llama-3.2-1B-Instruct",
                "variant": "1B",
            },
            "source": {
                "repository": "meta-llama/Llama-3.2-1B-Instruct",
                "revision": "0" * 40,
            },
            "tokenizer": {
                "repository": "meta-llama/Llama-3.2-1B-Instruct",
                "revision": "0" * 40,
                "files": ["tokenizer/tokenizer.json"],
            },
            "license": {
                "accepted": True,
                "acceptance_record": "SYNTHETIC-TEST-ONLY",
                "license_document": "license/LICENSE.txt",
                "aup_document": "license/USE_POLICY.md",
                "files": ["license/LICENSE.txt", "license/USE_POLICY.md"],
            },
            "files": [],
        }
        for rel, content in self.payloads.items():
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            role = (
                "model_weights" if rel.startswith("weights/") else
                "model_config" if rel.startswith("config/") else
                "tokenizer" if rel.startswith("tokenizer/") else
                "license" if rel.endswith("LICENSE.txt") else "aup"
            )
            self.manifest["files"].append({
                "path": rel,
                "size_bytes": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
                "role": role,
            })

        # Synthetic local Git clone. The weight file is represented by a
        # standard Git LFS pointer while the source directory contains bytes.
        shutil.copytree(self.root, self.git_repo)
        weight_pointer = (
            b"version https://git-lfs.github.com/spec/v1\n"
            + b"oid sha256:" + hashlib.sha256(self.payloads["weights/model.safetensors"]).hexdigest().encode()
            + b"\nsize " + str(len(self.payloads["weights/model.safetensors"])).encode() + b"\n"
        )
        (self.git_repo / "weights/model.safetensors").write_bytes(weight_pointer)
        self._git("init", "-q")
        self._git("remote", "add", "origin",
                  "https://huggingface.co/meta-llama/Llama-3.2-1B-Instruct")
        self._commit()
        self.manifest["source"]["revision"] = self.revision
        self.manifest["tokenizer"]["revision"] = self.revision
        self.write_manifest()

    def tearDown(self):
        self.temp.cleanup()

    def _git(self, *args):
        return subprocess.run(
            ["git", "-C", str(self.git_repo), *args],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={
                **__import__("os").environ,
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": __import__("os").devnull,
                "GIT_TERMINAL_PROMPT": "0",
            },
        ).stdout

    def _commit(self):
        self._git("add", "--all")
        self._git("-c", "user.name=ZERO Synthetic Test",
                  "-c", "user.email=zero-synthetic@example.invalid",
                  "-c", "core.hooksPath=/dev/null",
                  "commit", "-qm", "Synthetic source fixture")
        self.revision = self._git("rev-parse", "HEAD").decode().strip()

    def write_manifest(self):
        self.manifest_path.write_text(json.dumps(self.manifest), encoding="utf-8")

    def refresh_file_record(self, rel):
        content = (self.root / rel).read_bytes()
        entry = next(item for item in self.manifest["files"] if item["path"] == rel)
        entry["size_bytes"] = len(content)
        entry["sha256"] = hashlib.sha256(content).hexdigest()

    def test_valid_synthetic_git_inventory_passes_without_production_approval(self):
        result = validate(self.root, self.manifest_path, self.git_repo)
        self.assertTrue(result["valid"])
        self.assertEqual(result["files_checked"], 5)
        self.assertTrue(result["git_commit_object_verified"])
        self.assertTrue(result["git_origin_matches_official_repository"])
        self.assertEqual(
            result["git_file_content_checks"]["weights/model.safetensors"],
            "git-lfs-content-digest-matched",
        )
        self.assertFalse(result["production_approval"])
        self.assertFalse(result["publisher_signature_verified"])
        self.assertFalse(result["signature_verified"])
        self.assertFalse(result["coreml_artifact_verified"])

    def test_source_tokenizer_revision_mismatch_fails(self):
        self.manifest["tokenizer"]["revision"] = "b" * 40
        self.write_manifest()
        with self.assertRaisesRegex(ValidationError, "Tokenizer revision"):
            validate(self.root, self.manifest_path, self.git_repo)

    def test_nonexistent_local_git_revision_fails(self):
        self.manifest["source"]["revision"] = "b" * 40
        self.manifest["tokenizer"]["revision"] = "b" * 40
        self.write_manifest()
        with self.assertRaisesRegex(ValidationError, "Local Git command failed"):
            validate(self.root, self.manifest_path, self.git_repo)

    def test_origin_must_match_expected_official_repository(self):
        self._git("remote", "set-url", "origin", "https://example.invalid/not-meta")
        with self.assertRaisesRegex(ValidationError, "Local origin URL"):
            validate(self.root, self.manifest_path, self.git_repo)

    def test_file_tampering_fails_local_sha256(self):
        (self.root / "weights/model.safetensors").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValidationError, "size mismatch|SHA-256 mismatch"):
            validate(self.root, self.manifest_path, self.git_repo)

    def test_local_file_must_match_revision_tree_blob(self):
        (self.root / "config/config.json").write_bytes(b'{"changed":true}')
        self.refresh_file_record("config/config.json")
        self.write_manifest()
        with self.assertRaisesRegex(ValidationError, "do not match the source commit blob"):
            validate(self.root, self.manifest_path, self.git_repo)

    def test_undeclared_extra_file_fails_exact_inventory(self):
        (self.root / "extra.bin").write_bytes(b"extra")
        with self.assertRaisesRegex(ValidationError, "inventory mismatch"):
            validate(self.root, self.manifest_path, self.git_repo)

    def test_path_traversal_is_rejected(self):
        self.manifest["files"][0]["path"] = "../outside"
        self.write_manifest()
        with self.assertRaisesRegex(ValidationError, "traversal"):
            validate(self.root, self.manifest_path, self.git_repo)

    def test_unaccepted_license_fails(self):
        self.manifest["license"]["accepted"] = False
        self.write_manifest()
        with self.assertRaisesRegex(ValidationError, "acceptance"):
            validate(self.root, self.manifest_path, self.git_repo)

    def test_license_file_must_contain_official_document_markers(self):
        rel = "license/LICENSE.txt"
        changed = b"Terms and conditions. This is not the Llama license."
        (self.root / rel).write_bytes(changed)
        (self.git_repo / rel).write_bytes(changed)
        self._commit()
        self.manifest["source"]["revision"] = self.revision
        self.manifest["tokenizer"]["revision"] = self.revision
        self.refresh_file_record(rel)
        self.write_manifest()
        with self.assertRaisesRegex(ValidationError, "Llama Community License content"):
            validate(self.root, self.manifest_path, self.git_repo)

    def test_symlink_is_rejected(self):
        link = self.root / "linked"
        link.symlink_to(self.root / "config/config.json")
        with self.assertRaisesRegex(ValidationError, "Symlink"):
            validate(self.root, self.manifest_path, self.git_repo)

    def test_wrong_official_repository_fails(self):
        self.manifest["source"]["repository"] = "community/not-meta"
        self.write_manifest()
        with self.assertRaisesRegex(ValidationError, "official Meta"):
            validate(self.root, self.manifest_path, self.git_repo)

    def test_case_colliding_paths_fail(self):
        self.manifest["files"].append({
            "path": "WEIGHTS/model.safetensors",
            "size_bytes": 1,
            "sha256": "0" * 64,
            "role": "model_weights",
        })
        self.write_manifest()
        with self.assertRaisesRegex(ValidationError, "collision"):
            validate(self.root, self.manifest_path, self.git_repo)

    def test_non_string_tokenizer_path_fails_cleanly(self):
        self.manifest["tokenizer"]["files"] = [{"unexpected": "object"}]
        self.write_manifest()
        with self.assertRaisesRegex(ValidationError, "must be strings"):
            validate(self.root, self.manifest_path, self.git_repo)

    def test_3b_model_identity_is_checked(self):
        self.manifest["model"]["variant"] = "3B"
        self.manifest["model"]["model_id"] = "meta-llama/Llama-3.2-3B-Instruct"
        self.manifest["source"]["repository"] = "meta-llama/Llama-3.2-3B-Instruct"
        self.manifest["tokenizer"]["repository"] = "meta-llama/Llama-3.2-3B-Instruct"
        self._git("remote", "set-url", "origin",
                  "https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct")
        self.write_manifest()
        result = validate(self.root, self.manifest_path, self.git_repo)
        self.assertEqual(result["variant"], "3B")
        self.assertEqual(result["model_id"], "meta-llama/Llama-3.2-3B-Instruct")


if __name__ == "__main__":
    unittest.main()
