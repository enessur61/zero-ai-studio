from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from validate_preview_url import PREVIEW_HOST, validate_preview_url


class ValidatePreviewURLTests(unittest.TestCase):
    def test_accepts_exact_approved_preview_origin(self) -> None:
        self.assertEqual(
            validate_preview_url(f"https://{PREVIEW_HOST}", "true"),
            f"https://{PREVIEW_HOST}",
        )

    def test_normalizes_trailing_slash(self) -> None:
        self.assertEqual(
            validate_preview_url(f"https://{PREVIEW_HOST}/", "TRUE"),
            f"https://{PREVIEW_HOST}",
        )

    def test_rejects_missing_url(self) -> None:
        with self.assertRaisesRegex(ValueError, "missing"):
            validate_preview_url("", "true")

    def test_rejects_missing_isolation_approval(self) -> None:
        with self.assertRaisesRegex(ValueError, "not been explicitly approved"):
            validate_preview_url(f"https://{PREVIEW_HOST}", "")

    def test_rejects_live_service_host(self) -> None:
        with self.assertRaisesRegex(ValueError, "approved Preview host"):
            validate_preview_url("https://zero-ai-studio.onrender.com", "true")

    def test_rejects_other_preview_host(self) -> None:
        with self.assertRaisesRegex(ValueError, "approved Preview host"):
            validate_preview_url("https://example.com", "true")

    def test_rejects_http(self) -> None:
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            validate_preview_url(f"http://{PREVIEW_HOST}", "true")

    def test_rejects_credentials(self) -> None:
        with self.assertRaisesRegex(ValueError, "credentials"):
            validate_preview_url(f"https://user:password@{PREVIEW_HOST}", "true")

    def test_rejects_non_standard_port(self) -> None:
        with self.assertRaisesRegex(ValueError, "non-standard port"):
            validate_preview_url(f"https://{PREVIEW_HOST}:8443", "true")

    def test_rejects_path(self) -> None:
        with self.assertRaisesRegex(ValueError, "without path"):
            validate_preview_url(f"https://{PREVIEW_HOST}/admin", "true")

    def test_rejects_query(self) -> None:
        with self.assertRaisesRegex(ValueError, "without path"):
            validate_preview_url(f"https://{PREVIEW_HOST}?token=x", "true")

    def test_rejects_fragment(self) -> None:
        with self.assertRaisesRegex(ValueError, "without path"):
            validate_preview_url(f"https://{PREVIEW_HOST}#section", "true")

    def test_rejects_whitespace(self) -> None:
        with self.assertRaisesRegex(ValueError, "whitespace"):
            validate_preview_url(f" https://{PREVIEW_HOST}", "true")


if __name__ == "__main__":
    unittest.main()
