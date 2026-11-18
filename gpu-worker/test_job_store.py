from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from job_store import PersistentJobStore, has_persistent_mount, require_persistent_storage


class PersistentJobStoreTests(unittest.TestCase):
    def test_ephemeral_worker_storage_is_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "persistent volume"):
            require_persistent_storage(False)

    def test_configured_persistent_worker_storage_is_accepted(self) -> None:
        require_persistent_storage(True)

    def test_overlay_container_layer_is_not_a_persistent_volume(self) -> None:
        mountinfo = "36 25 0:32 / / rw,relatime - overlay overlay rw"
        self.assertFalse(has_persistent_mount("/data/zero-wan-jobs", mountinfo))

    def test_tmpfs_mount_is_not_a_persistent_volume(self) -> None:
        mountinfo = (
            "36 25 0:32 / / rw,relatime - overlay overlay rw\n"
            "40 36 0:44 / /data rw,nosuid - tmpfs tmpfs rw"
        )
        self.assertFalse(has_persistent_mount("/data/zero-wan-jobs", mountinfo))

    def test_real_volume_mount_is_detected_beneath_output_directory(self) -> None:
        mountinfo = (
            "36 25 0:32 / / rw,relatime - overlay overlay rw\n"
            "40 36 8:1 / /data rw,relatime - ext4 /dev/sda rw"
        )
        self.assertTrue(has_persistent_mount("/data/zero-wan-jobs", mountinfo))

    def test_nested_ephemeral_mount_overrides_persistent_parent(self) -> None:
        mountinfo = (
            "36 25 0:32 / / rw,relatime - overlay overlay rw\n"
            "40 36 8:1 / /data rw,relatime - ext4 /dev/sda rw\n"
            "41 40 0:44 / /data/zero-wan-jobs rw,nosuid - tmpfs tmpfs rw"
        )
        self.assertFalse(has_persistent_mount("/data/zero-wan-jobs", mountinfo))

    def test_restart_preserves_completed_jobs_and_marks_interrupted_jobs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            video = output / "completed.mp4"
            video.write_bytes(b"fake-mp4")
            first = PersistentJobStore(output)
            first.save({"id": "queued", "status": "queued", "created_at": "2026-11-17T00:00:00Z"})
            first.save({"id": "running", "status": "running", "created_at": "2026-11-17T00:01:00Z"})
            first.save({
                "id": "succeeded", "status": "succeeded", "filename": "completed.mp4",
                "created_at": "2026-11-17T00:02:00Z",
            })
            first.save({
                "id": "missing", "status": "succeeded", "filename": "missing.mp4",
                "created_at": "2026-11-17T00:03:00Z",
            })

            restarted = PersistentJobStore(output)
            jobs = restarted.load_all()
            self.assertEqual(jobs["queued"]["status"], "failed")
            self.assertIn("neu gestartet", jobs["queued"]["error"])
            self.assertEqual(jobs["running"]["status"], "failed")
            self.assertEqual(jobs["succeeded"]["status"], "succeeded")
            self.assertEqual(jobs["missing"]["status"], "failed")

            second_restart = PersistentJobStore(output).load_all()
            self.assertEqual(second_restart["queued"]["status"], "failed")
            self.assertTrue(video.is_file())

    def test_separate_process_restart_recovers_jobs_and_video_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            video = output / "survives-restart.mp4"
            video.write_bytes(b"persistent-mp4-content")
            first_process = """
from pathlib import Path
from job_store import PersistentJobStore
store = PersistentJobStore(Path(__import__('sys').argv[1]))
store.save({"id": "completed", "status": "succeeded", "filename": "survives-restart.mp4"})
store.save({"id": "interrupted", "status": "running"})
"""
            subprocess.run(
                [sys.executable, "-c", first_process, str(output)],
                check=True,
                cwd=Path(__file__).parent,
            )
            second_process = """
import json
from pathlib import Path
from job_store import PersistentJobStore
root = Path(__import__('sys').argv[1])
jobs = PersistentJobStore(root).load_all()
assert jobs["completed"]["status"] == "succeeded"
assert jobs["interrupted"]["status"] == "failed"
assert (root / jobs["completed"]["filename"]).read_bytes() == b"persistent-mp4-content"
print(json.dumps({"completed": jobs["completed"]["status"], "interrupted": jobs["interrupted"]["status"]}))
"""
            result = subprocess.run(
                [sys.executable, "-c", second_process, str(output)],
                check=True,
                cwd=Path(__file__).parent,
                capture_output=True,
                text=True,
            )
            self.assertIn('"completed": "succeeded"', result.stdout)
            self.assertIn('"interrupted": "failed"', result.stdout)

    def test_daily_job_limit_survives_deletion_and_worker_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = PersistentJobStore(directory)
            for index in range(1, 4):
                allowed, reason, count = store.create_job_if_allowed({"id": f"job-{index}", "status": "queued"}, daily_limit=3, max_concurrent=10, utc_day="2026-11-18")
                self.assertTrue(allowed)
                self.assertEqual(reason, "accepted")
                self.assertEqual(count, index)
            blocked, reason, count = store.create_job_if_allowed({"id": "job-4", "status": "queued"}, daily_limit=3, max_concurrent=10, utc_day="2026-11-18")
            self.assertFalse(blocked)
            self.assertEqual(reason, "daily_limit")
            self.assertEqual(count, 3)
            store.delete("job-1")
            restarted = PersistentJobStore(directory)
            blocked_again, reason_again, count_again = restarted.create_job_if_allowed({"id": "job-5", "status": "queued"}, daily_limit=3, max_concurrent=10, utc_day="2026-11-18")
            self.assertFalse(blocked_again)
            self.assertEqual(reason_again, "daily_limit")
            self.assertEqual(count_again, 3)

    def test_active_job_limit_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = PersistentJobStore(directory)
            allowed, _, _ = store.create_job_if_allowed({"id": "active-1", "status": "queued"}, daily_limit=3, max_concurrent=1, utc_day="2026-11-18")
            self.assertTrue(allowed)
            blocked, reason, count = store.create_job_if_allowed({"id": "active-2", "status": "queued"}, daily_limit=3, max_concurrent=1, utc_day="2026-11-18")
            self.assertFalse(blocked)
            self.assertEqual(reason, "concurrency_limit")
            self.assertEqual(count, 1)

    def test_daily_job_limit_uses_utc_day_key(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = PersistentJobStore(directory)
            allowed, _, _ = store.create_job_if_allowed({"id": "day-1", "status": "queued"}, daily_limit=1, max_concurrent=2, utc_day="2026-11-18")
            self.assertTrue(allowed)
            allowed_next_day, _, count = store.create_job_if_allowed({"id": "day-2", "status": "queued"}, daily_limit=1, max_concurrent=2, utc_day="2026-11-19")
            self.assertTrue(allowed_next_day)
            self.assertEqual(count, 1)
    def test_daily_usage_is_reported_from_persisted_utc_quota(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = PersistentJobStore(directory)
            self.assertEqual(store.daily_usage("2026-11-18"), 0)
            for index in range(1, 4):
                allowed, _, _ = store.create_job_if_allowed(
                    {"id": f"quota-{index}", "status": "failed"},
                    daily_limit=3,
                    max_concurrent=3,
                    utc_day="2026-11-18",
                )
                self.assertTrue(allowed)
            self.assertEqual(store.daily_usage("2026-11-18"), 3)
            self.assertEqual(store.daily_usage("2026-11-19"), 0)

    def test_delete_removes_persisted_job(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = PersistentJobStore(directory)
            store.save({"id": "job-1", "status": "failed", "created_at": "2026-11-17T00:00:00Z"})
            store.delete("job-1")
            self.assertNotIn("job-1", store.load_all())


if __name__ == "__main__":
    unittest.main()
