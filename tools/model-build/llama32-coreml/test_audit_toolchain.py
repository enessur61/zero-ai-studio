import tempfile
import unittest
import zipfile
from pathlib import Path

from audit_toolchain import wheel_metadata


class WheelMetadataTests(unittest.TestCase):
    def test_selects_canonical_distribution_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            wheel = Path(temporary) / "demo_pkg-1.2.3-py3-none-any.whl"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr(
                    "demo_pkg-1.2.3.dist-info/METADATA",
                    "Metadata-Version: 2.1\nName: demo-pkg\nVersion: 1.2.3\n",
                )
                archive.writestr(
                    "vendored_dependency-9.8.dist-info/METADATA",
                    "Metadata-Version: 2.1\nName: wrong-package\nVersion: 9.8\n",
                )
            self.assertEqual(wheel_metadata(wheel), ("demo-pkg", "1.2.3"))

    def test_missing_canonical_metadata_fails_with_candidates(self):
        with tempfile.TemporaryDirectory() as temporary:
            wheel = Path(temporary) / "demo_pkg-1.2.3-py3-none-any.whl"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr(
                    "vendored_dependency-9.8.dist-info/METADATA",
                    "Metadata-Version: 2.1\nName: wrong-package\nVersion: 9.8\n",
                )
            with self.assertRaisesRegex(RuntimeError, "canonical wheel METADATA"):
                wheel_metadata(wheel)

    def test_duplicate_canonical_metadata_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            wheel = Path(temporary) / "demo_pkg-1.2.3-py3-none-any.whl"
            with zipfile.ZipFile(wheel, "w") as archive:
                metadata = (
                    "Metadata-Version: 2.1\nName: demo-pkg\nVersion: 1.2.3\n"
                )
                archive.writestr("demo_pkg-1.2.3.dist-info/METADATA", metadata)
                archive.writestr("demo_pkg-1.2.3.dist-info/METADATA", metadata)
            with self.assertRaisesRegex(RuntimeError, "canonical wheel METADATA"):
                wheel_metadata(wheel)


if __name__ == "__main__":
    unittest.main()
