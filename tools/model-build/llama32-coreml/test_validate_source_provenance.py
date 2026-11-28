"""Synthetic-only unit tests for the offline provenance validator."""
from __future__ import annotations

import hashlib
import json
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
        self.manifest_path = self.base / "manifest.json"
        self.payloads = {
            "weights/model.safetensors": b"SYNTHETIC TEST DATA - NOT MODEL WEIGHTS",
            "config/config.json": b'{"synthetic_fixture":true}',
            "tokenizer/tokenizer.json": b'{"synthetic_fixture":true}',
            "license/LICENSE": b"SYNTHETIC LICENSE FIXTURE",
            "license/USE_POLICY": b"SYNTHETIC AUP FIXTURE",
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
                "revision": "a" * 40,
            },
            "tokenizer": {
                "repository": "meta-llama/Llama-3.2-1B-Instruct",
                "revision": "a" * 40,
                "files": ["tokenizer/tokenizer.json"],
            },
            "license": {
                "accepted": True,
                "acceptance_record": "SYNTHETIC-TEST-ONLY",
                "files": ["license/LICENSE", "license/USE_POLICY"],
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
                "license" if rel.endswith("LICENSE") else "aup"
            )
            self.manifest["files"].append({
                "path": rel,
                "size_bytes": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
                "role": role,
            })
        self.write_manifest()

    def tearDown(self):
        self.temp.cleanup()

    def write_manifest(self):
        self.manifest_path.write_text(json.dumps(self.manifest), encoding="utf-8")

    def test_valid_synthetic_inventory_passes_without_production_approval(self):
        result = validate(self.root, self.manifest_path)
        self.assertTrue(result["valid"])
        self.assertEqual(result["files_checked"], 5)
        self.assertFalse(result["production_approval"])
        self.assertFalse(result["signature_verified"])
        self.assertFalse(result["coreml_artifact_verified"])

    def test_source_tokenizer_revision_mismatch_fails(self):
        self.manifest["tokenizer"]["revision"] = "b" * 40
        self.write_manifest()
        with self.assertRaisesRegex(ValidationError, "Tokenizer revision"):
            validate(self.root, self.manifest_path)

    def test_file_tampering_fails_sha256(self):
        (self.root / "weights/model.safetensors").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValidationError, "size mismatch|SHA-256 mismatch"):
            validate(self.root, self.manifest_path)

    def test_undeclared_extra_file_fails_exact_inventory(self):
        (self.root / "extra.bin").write_bytes(b"extra")
        with self.assertRaisesRegex(ValidationError, "inventory mismatch"):
            validate(self.root, self.manifest_path)

    def test_path_traversal_is_rejected(self):
        self.manifest["files"][0]["path"] = "../outside"
        self.write_manifest()
        with self.assertRaisesRegex(ValidationError, "traversal"):
            validate(self.root, self.manifest_path)

    def test_unaccepted_license_fails(self):
        self.manifest["license"]["accepted"] = False
        self.write_manifest()
        with self.assertRaisesRegex(ValidationError, "acceptance"):
            validate(self.root, self.manifest_path)

    def test_symlink_is_rejected(self):
        link = self.root / "linked"
        link.symlink_to(self.root / "config/config.json")
        with self.assertRaisesRegex(ValidationError, "Symlink"):
            validate(self.root, self.manifest_path)

    def test_wrong_official_repository_fails(self):
        self.manifest["source"]["repository"] = "community/not-meta"
        self.write_manifest()
        with self.assertRaisesRegex(ValidationError, "official Meta"):
            validate(self.root, self.manifest_path)

    def test_case_colliding_paths_fail(self):
        self.manifest["files"].append({
            "path": "WEIGHTS/model.safetensors",
            "size_bytes": 1,
            "sha256": "0" * 64,
            "role": "model_weights",
        })
        self.write_manifest()
        with self.assertRaisesRegex(ValidationError, "collision"):
            validate(self.root, self.manifest_path)

    def test_non_string_tokenizer_path_fails_cleanly(self):
        self.manifest["tokenizer"]["files"] = [{"unexpected": "object"}]
        self.write_manifest()
        with self.assertRaisesRegex(ValidationError, "must be strings"):
            validate(self.root, self.manifest_path)

    def test_3b_model_identity_is_checked(self):
        self.manifest["model"]["variant"] = "3B"
        self.manifest["model"]["model_id"] = "meta-llama/Llama-3.2-3B-Instruct"
        self.manifest["source"]["repository"] = "meta-llama/Llama-3.2-3B-Instruct"
        self.manifest["tokenizer"]["repository"] = "meta-llama/Llama-3.2-3B-Instruct"
        self.write_manifest()
        result = validate(self.root, self.manifest_path)
        self.assertEqual(result["variant"], "3B")
        self.assertEqual(result["model_id"], "meta-llama/Llama-3.2-3B-Instruct")


if __name__ == "__main__":
    unittest.main()
