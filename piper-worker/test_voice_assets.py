from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import voice_assets
from voice_assets import (
    MODEL_SHA256,
    MODEL_SIZE_BYTES,
    VOICE_ID,
    VOICE_REVISION,
    validate_voice_config,
)


class PinnedVoiceAssetTests(unittest.TestCase):
    def make_config(self) -> dict:
        return {
            "audio": {"sample_rate": 22050},
            "espeak": {"voice": "de"},
            "phoneme_type": "espeak",
            "num_symbols": 256,
            "num_speakers": 1,
            "inference": {"noise_scale": 0.5, "length_scale": 1.0, "noise_w": 0.333},
            "phoneme_id_map": {"_": [0], "a": [1]},
            "speaker_id_map": {},
            "hop_length": 256,
            "default_speaker_id": 0,
            "piper_version": "1.5.0",
            "language": {"code": "de_DE"},
        }

    def test_pin_metadata_is_immutable_and_complete(self):
        self.assertEqual(VOICE_ID, "de_DE-thorsten-medium")
        self.assertEqual(VOICE_REVISION, "cf910fb59f1d79ab3b625a63993a108751c6c25d")
        self.assertEqual(MODEL_SIZE_BYTES, 63_221_984)
        self.assertEqual(MODEL_SHA256, "fd270eb3d1ebf91d763f8a0f949b1b1bebdfefaea18c3aaf8577dd34536e064f")

    def test_accepts_pinned_voice_config_shape(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "voice.json"
            path.write_text(json.dumps(self.make_config()), encoding="utf-8")
            self.assertEqual(validate_voice_config(path)["piper_version"], "1.5.0")

    def test_rejects_legacy_engine_config(self):
        config = self.make_config()
        config["piper_version"] = "1.3.0"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "voice.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "pinned rdh-based"):
                validate_voice_config(path)

    def test_model_sha256_validation_accepts_only_the_pinned_bytes(self):
        payload = b"pinned test model"
        expected = hashlib.sha256(payload).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "voice.onnx"
            path.write_bytes(payload)
            voice_assets.validate_model_file(
                path,
                expected_size=len(payload),
                expected_sha256=expected,
            )
            path.write_bytes(b"pinned test modes")
            with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                voice_assets.validate_model_file(
                    path,
                    expected_size=len(payload),
                    expected_sha256=expected,
                )

    def test_rejects_non_object_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "voice.json"
            path.write_text("[]", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "root must be a JSON object"):
                validate_voice_config(path)

    def test_rejects_wrong_inference_defaults(self):
        config = self.make_config()
        config["inference"]["noise_w"] = 0.8
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "voice.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "pinned rdh-based"):
                validate_voice_config(path)


if __name__ == "__main__":
    unittest.main()
