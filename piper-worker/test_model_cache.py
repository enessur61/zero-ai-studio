from __future__ import annotations

import hashlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app


class ModelCachePersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "voice.onnx"
        self.payload = b"zero-ci-piper-model-fixture"
        self.expected = hashlib.md5(self.payload).hexdigest()
        self.url = "https://models.invalid/pinned/voice.onnx"
        self.calls = []

    def _response(self):
        return io.BytesIO(self.payload)

    def test_verified_model_is_cached_and_reused_without_network(self):
        with patch.dict(app.MD5, {"model": self.expected}), patch.dict(app.EXPECTED_SIZES, {"model": len(self.payload)}), patch.dict(app.SHA256, {"model": hashlib.sha256(self.payload).hexdigest()}), patch.dict(app.URLS, {"model": self.url}), patch(
            "app.urllib.request.urlopen", side_effect=lambda *a, **k: (self.calls.append(a[0].full_url) or self._response())
        ):
            app.download("model", self.path, 1024)
            app.download("model", self.path, 1024)

        self.assertEqual(self.path.read_bytes(), self.payload)
        self.assertEqual(self.calls, [self.url])
        self.assertFalse(self.path.with_suffix(".onnx.part").exists())

    def test_corrupt_cached_model_is_replaced_after_integrity_check(self):
        self.path.write_bytes(b"corrupt")
        with patch.dict(app.MD5, {"model": self.expected}), patch.dict(app.EXPECTED_SIZES, {"model": len(self.payload)}), patch.dict(app.SHA256, {"model": hashlib.sha256(self.payload).hexdigest()}), patch.dict(app.URLS, {"model": self.url}), patch(
            "app.urllib.request.urlopen", side_effect=lambda *a, **k: self._response()
        ):
            app.download("model", self.path, 1024)

        self.assertEqual(self.path.read_bytes(), self.payload)
        self.assertFalse(self.path.with_suffix(".onnx.part").exists())

    def test_interrupted_download_leaves_no_partial_model(self):
        class InterruptedResponse:
            def __enter__(self):
                return self
            def __exit__(self, *_):
                return False
            def read(self, _size):
                if not hasattr(self, "sent"):
                    self.sent = True
                    return b"partial"
                raise OSError("simulated interrupted download")

        with patch.dict(app.MD5, {"model": self.expected}), patch.dict(app.EXPECTED_SIZES, {"model": len(self.payload)}), patch.dict(app.SHA256, {"model": hashlib.sha256(self.payload).hexdigest()}), patch.dict(app.URLS, {"model": self.url}), patch(
            "app.urllib.request.urlopen", return_value=InterruptedResponse()
        ):
            with self.assertRaises(OSError):
                app.download("model", self.path, 1024)

        self.assertFalse(self.path.exists())
        self.assertFalse(self.path.with_suffix(".onnx.part").exists())


    def test_pinned_voice_revision_and_metadata_are_exact(self):
        self.assertEqual(app.REV, "cf910fb59f1d79ab3b625a63993a108751c6c25d")
        self.assertEqual(app.EXPECTED_SIZES, {"model": 63221984, "config": 6455})
        self.assertEqual(app.MD5["model"], "e2fe077168bfe802e951e717dfa85873")
        self.assertEqual(app.MD5["config"], "dac4f7530c978753aeb40f214245659f")
        self.assertEqual(app.SHA256["model"], "fd270eb3d1ebf91d763f8a0f949b1b1bebdfefaea18c3aaf8577dd34536e064f")
        self.assertEqual((app.NOISE_SCALE, app.NOISE_W_SCALE), (0.5, 0.333))

    def test_download_rejects_wrong_pinned_size(self):
        with patch.dict(app.MD5, {"model": self.expected}), patch.dict(
            app.EXPECTED_SIZES, {"model": len(self.payload) + 1}
        ), patch.dict(app.SHA256, {"model": hashlib.sha256(self.payload).hexdigest()}), patch.dict(
            app.URLS, {"model": self.url}
        ), patch("app.urllib.request.urlopen", return_value=self._response()):
            with self.assertRaisesRegex(RuntimeError, "size does not match"):
                app.download("model", self.path, 1024)

        self.assertFalse(self.path.exists())
        self.assertFalse(self.path.with_suffix(".onnx.part").exists())

    def test_synthesize_preserves_voice_load_failure_without_wave_error_masking(self):
        with patch("app.get_voice", side_effect=RuntimeError("pinned voice config mismatch")):
            with self.assertRaisesRegex(RuntimeError, "pinned voice config mismatch"):
                app.synthesize("ZERO lokaler Regressionstest.", 1.0)



    def test_health_payload_matches_server_readiness_contract(self):
        with patch.object(app, "APP_TOKEN", "zero-ci-worker-token-with-at-least-32-characters"):
            payload = app.health()

        self.assertEqual(payload["ok"], True)
        self.assertEqual(payload["auth_configured"], True)
        self.assertEqual(payload["engine"], "Piper ONNX CPU")
        self.assertEqual(payload["model_id"], "de_DE-thorsten-medium")
        self.assertEqual(payload["voice"], "de_DE-thorsten-medium")
        self.assertEqual(payload["engine_version"], "1.8.0")
        self.assertEqual(payload["model_revision"], app.REV)
        self.assertEqual(payload["voice_revision"], app.REV)
        self.assertEqual(payload["engine_license"], "GPL-3.0-or-later")
        self.assertEqual(payload["voice_dataset_license"], "CC0")
        self.assertEqual(payload["voice_training_base"], "rdh (nl_BE, one Flemish speaker, CC0)")
        self.assertEqual(payload["model_sha256"], app.MODEL_SHA256)
        self.assertEqual(payload["cost_eur"], 0)
        self.assertEqual(payload["paid_fallback"], False)
        self.assertEqual(payload["commercial_use_confirmed"], False)


if __name__ == "__main__":
    unittest.main()
