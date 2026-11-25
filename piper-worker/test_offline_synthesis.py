from __future__ import annotations

import io
import platform
import unittest
import wave
from unittest.mock import patch

import app
from voice_assets import (
    MODEL_SHA256,
    MODEL_SIZE_BYTES,
    VOICE_CONFIG_SHA256,
    sha256_file,
    validate_model_file,
    validate_voice_config,
)


class OfflineArm64PiperSynthesisTests(unittest.TestCase):
    def test_real_pinned_voice_synthesizes_without_network(self) -> None:
        self.assertIn(platform.machine().lower(), {"aarch64", "arm64"})
        self.assertIn("CPUExecutionProvider", app.ONNX_PROVIDERS)

        self.assertTrue(app.MODEL.is_file(), "Pinned ONNX model must be preloaded")
        self.assertTrue(app.CONFIG.is_file(), "Pinned JSON config must be preloaded")
        self.assertEqual(app.MODEL.stat().st_size, MODEL_SIZE_BYTES)
        self.assertEqual(app.CONFIG.stat().st_size, 5460)
        self.assertEqual(sha256_file(app.MODEL), MODEL_SHA256)
        self.assertEqual(sha256_file(app.CONFIG), VOICE_CONFIG_SHA256)
        validate_model_file(app.MODEL)
        validate_voice_config(app.CONFIG)

        # The cache is mounted read-only and the container has --network none.
        # Any attempt to fetch either pinned asset therefore fails the test.
        with patch(
            "app.urllib.request.urlopen",
            side_effect=AssertionError("offline Piper synthesis attempted a download"),
        ) as blocked_download:
            first_audio = app.synthesize(
                "ZERO ARM64 Offline-Test. Diese deutsche Stimme wird lokal erzeugt.",
                1.0,
            )
            self.assertIsNotNone(app.voice, "Piper must load the real ONNX voice")
            self._assert_valid_wav(first_audio)

            # Force a second load from the verified on-disk cache.
            app.voice = None
            second_audio = app.synthesize(
                "ZERO lädt die geprüfte Stimme erneut ohne Netzwerk.",
                1.0,
            )
            self.assertIsNotNone(app.voice)
            self._assert_valid_wav(second_audio)

        blocked_download.assert_not_called()

    def _assert_valid_wav(self, payload: bytes) -> None:
        with wave.open(io.BytesIO(payload), "rb") as audio:
            self.assertEqual(audio.getnchannels(), 1)
            self.assertEqual(audio.getsampwidth(), 2)
            self.assertEqual(audio.getframerate(), 22050)
            self.assertGreater(audio.getnframes(), 0)
            self.assertGreater(len(audio.readframes(audio.getnframes())), 0)


if __name__ == "__main__":
    unittest.main()
