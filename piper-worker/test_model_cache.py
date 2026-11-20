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


if __name__ == "__main__":
    unittest.main()
