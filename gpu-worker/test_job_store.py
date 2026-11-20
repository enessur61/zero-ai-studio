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

    def test_idempotent_create_returns_same_job_and_rejects_changed_payload(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = PersistentJobStore(directory)
            first = {
                "id": "job-one", "status": "queued", "principal_hash": "a" * 64,
                "idempotency_key_hash": "b" * 64, "request_fingerprint": "c" * 64,
                "project_id": "project-1", "scene_id": "scene-1",
            }
            created, replayed, conflict = store.create_or_get(first)
            self.assertEqual(created["id"], "job-one")
            self.assertFalse(replayed)
            self.assertFalse(conflict)

            retry = dict(first, id="job-two")
            existing, replayed, conflict = store.create_or_get(retry)
            self.assertEqual(existing["id"], "job-one")
            self.assertTrue(replayed)
            self.assertFalse(conflict)

            changed = dict(retry, request_fingerprint="d" * 64)
            existing, replayed, conflict = store.create_or_get(changed)
            self.assertEqual(existing["id"], "job-one")
            self.assertTrue(replayed)
            self.assertTrue(conflict)

    def test_idempotency_is_scoped_to_principal_and_jobs_are_listed_by_project(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = PersistentJobStore(directory)
            base = {
                "id": "job-a", "status": "succeeded", "principal_hash": "a" * 64,
                "idempotency_key_hash": "b" * 64, "request_fingerprint": "c" * 64,
                "project_id": "project-1", "scene_id": "scene-1",
            }
            store.create_or_get(base)
            other_principal = dict(base, id="job-b", principal_hash="e" * 64)
            created, replayed, conflict = store.create_or_get(other_principal)
            self.assertEqual(created["id"], "job-b")
            self.assertFalse(replayed)
            self.assertFalse(conflict)
            self.assertEqual([job["id"] for job in store.list_by_principal("a" * 64, "project-1")], ["job-a"])
            self.assertEqual(store.list_by_principal("f" * 64), [])
            self.assertEqual(store.list_by_principal("a" * 64, "other-project"), [])

    def test_job_list_orders_latest_updated_jobs_first_even_with_same_second_timestamp(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = PersistentJobStore(directory)
            for job_id, key_hash in (("older", "1" * 64), ("newer", "2" * 64)):
                store.create_or_get({
                    "id": job_id, "status": "succeeded", "principal_hash": "a" * 64,
                    "idempotency_key_hash": key_hash, "request_fingerprint": "f" * 64,
                    "project_id": "project-1", "scene_id": "scene-1",
                })
            listed = store.list_by_principal("a" * 64, "project-1")
            self.assertEqual([job["id"] for job in listed], ["newer", "older"])

    def test_project_job_deletion_is_principal_scoped_and_removes_completed_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = PersistentJobStore(directory)
            completed_file = Path(directory) / "completed.mp4"
            other_file = Path(directory) / "other.mp4"
            completed_file.write_bytes(b"video")
            other_file.write_bytes(b"video")
            store.create_or_get({
                "id": "completed", "status": "succeeded", "filename": "completed.mp4",
                "principal_hash": "a" * 64, "idempotency_key_hash": "b" * 64,
                "request_fingerprint": "c" * 64, "project_id": "project-1",
            })
            store.create_or_get({
                "id": "other-principal", "status": "succeeded", "filename": "other.mp4",
                "principal_hash": "e" * 64, "idempotency_key_hash": "b" * 64,
                "request_fingerprint": "c" * 64, "project_id": "project-1",
            })
            removed = store.mark_project_jobs_for_deletion("a" * 64, "project-1")
            self.assertEqual([job["id"] for job in removed], ["completed"])
            self.assertNotIn("completed", store.load_all())
            self.assertTrue(other_file.is_file(), "another principal's worker file must remain untouched")

    def test_active_project_jobs_are_marked_for_deferred_cleanup_and_removed_on_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = PersistentJobStore(directory)
            video = Path(directory) / "running.mp4"
            video.write_bytes(b"video")
            store.create_or_get({
                "id": "running", "status": "running", "filename": "running.mp4",
                "principal_hash": "a" * 64, "idempotency_key_hash": "b" * 64,
                "request_fingerprint": "c" * 64, "project_id": "project-1",
            })
            marked = store.mark_project_jobs_for_deletion("a" * 64, "project-1")
            self.assertEqual(len(marked), 1)
            self.assertEqual(marked[0]["status"], "deleting")
            restarted = PersistentJobStore(directory).load_all()
            self.assertEqual(restarted, {})
            self.assertFalse(video.exists())

    def test_project_filter_is_applied_before_job_history_limit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = PersistentJobStore(directory)
            for index in range(55):
                store.create_or_get({
                    "id": f"other-{index}", "status": "failed", "principal_hash": "a" * 64,
                    "idempotency_key_hash": f"{index + 1:064x}", "request_fingerprint": "f" * 64,
                    "project_id": "other-project",
                })
            store.create_or_get({
                "id": "target-project-job", "status": "succeeded", "principal_hash": "a" * 64,
                "idempotency_key_hash": "f" * 64, "request_fingerprint": "f" * 64,
                "project_id": "target-project",
            })
            self.assertEqual(
                [job["id"] for job in store.list_by_principal("a" * 64, "target-project")],
                ["target-project-job"],
            )

    def test_delete_removes_persisted_job(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = PersistentJobStore(directory)
            store.save({"id": "job-1", "status": "failed", "created_at": "2026-11-17T00:00:00Z"})
            store.delete("job-1")
            self.assertNotIn("job-1", store.load_all())


    def test_limited_create_is_principal_idempotent_and_enforces_daily_and_gpu_concurrency(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = PersistentJobStore(directory)
            first = {
                "id": "job-one", "status": "queued", "principal_hash": "a" * 64,
                "idempotency_key_hash": "b" * 64, "request_fingerprint": "c" * 64,
                "project_id": "project-1", "scene_id": "scene-1",
            }
            created, replayed, conflict, reason, count = store.create_or_get_limited(
                first, daily_limit=2, max_concurrent=1, utc_day="2026-11-20"
            )
            self.assertEqual(created["id"], "job-one")
            self.assertFalse(replayed)
            self.assertFalse(conflict)
            self.assertIsNone(reason)
            self.assertEqual(count, 1)

            retry = dict(first, id="job-two")
            existing, replayed, conflict, reason, count = store.create_or_get_limited(
                retry, daily_limit=2, max_concurrent=1, utc_day="2026-11-20"
            )
            self.assertEqual(existing["id"], "job-one")
            self.assertTrue(replayed)
            self.assertFalse(conflict)
            self.assertEqual(store.daily_usage("2026-11-20"), 1)

            changed = dict(retry, request_fingerprint="d" * 64)
            _existing, replayed, conflict, _reason, _count = store.create_or_get_limited(
                changed, daily_limit=2, max_concurrent=1, utc_day="2026-11-20"
            )
            self.assertTrue(replayed)
            self.assertTrue(conflict)

            blocked, replayed, conflict, reason, _count = store.create_or_get_limited(
                dict(first, id="job-three", idempotency_key_hash="e" * 64),
                daily_limit=2, max_concurrent=1, utc_day="2026-11-20",
            )
            self.assertIsNone(blocked)
            self.assertFalse(replayed)
            self.assertFalse(conflict)
            self.assertEqual(reason, "concurrency_limit")

            store.save(dict(first, status="failed"))
            second, replayed, conflict, reason, count = store.create_or_get_limited(
                dict(first, id="job-four", idempotency_key_hash="f" * 64),
                daily_limit=2, max_concurrent=1, utc_day="2026-11-20",
            )
            self.assertEqual(second["id"], "job-four")
            self.assertFalse(replayed)
            self.assertFalse(conflict)
            self.assertIsNone(reason)
            self.assertEqual(count, 2)

            third, _replayed, _conflict, reason, _count = store.create_or_get_limited(
                dict(first, id="job-five", idempotency_key_hash="1" * 64),
                daily_limit=2, max_concurrent=1, utc_day="2026-11-20",
            )
            self.assertIsNone(third)
            self.assertEqual(reason, "concurrency_limit")
            store.save(dict(second, status="failed"))
            fourth, _replayed, _conflict, reason, _count = store.create_or_get_limited(
                dict(first, id="job-six", idempotency_key_hash="2" * 64),
                daily_limit=2, max_concurrent=1, utc_day="2026-11-20",
            )
            self.assertIsNone(fourth)
            self.assertEqual(reason, "daily_limit")
            self.assertEqual(store.daily_usage("2026-11-20"), 2)

    def test_cancel_requests_are_principal_scoped_and_survive_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = PersistentJobStore(directory)
            queued = {
                "id": "queued-job", "status": "queued", "principal_hash": "a" * 64,
                "idempotency_key_hash": "b" * 64, "request_fingerprint": "c" * 64,
                "project_id": "project-1",
            }
            store.create_or_get(queued)
            self.assertIsNone(store.request_cancel("queued-job", "e" * 64))
            cancelled = store.request_cancel("queued-job", "a" * 64)
            self.assertEqual(cancelled["status"], "cancelled")
            self.assertEqual(store.request_cancel("queued-job", "a" * 64)["status"], "cancelled")

            running = dict(queued, id="running-job", status="running", idempotency_key_hash="d" * 64)
            store.create_or_get(running)
            requested = store.request_cancel("running-job", "a" * 64)
            self.assertEqual(requested["status"], "cancel_requested")
            self.assertEqual(store.request_cancel("running-job", "e" * 64), None)

            recovered = PersistentJobStore(directory).load_all()
            self.assertEqual(recovered["queued-job"]["status"], "cancelled")
            self.assertEqual(recovered["running-job"]["status"], "cancelled")
            self.assertIn("Neustart", recovered["running-job"]["cancel_reason"])

    def test_cancelled_jobs_are_terminal_and_prunable_without_pruning_daily_quota(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = PersistentJobStore(directory)
            for index in range(50):
                status = "cancelled" if index == 0 else "failed"
                store.save({
                    "id": f"job-{index}", "status": status,
                    "created_at": f"2026-11-{1 + (index % 17):02d}T00:00:00Z",
                })
            store.create_or_get_limited({
                "id": "quota-job", "status": "failed", "principal_hash": "a" * 64,
                "idempotency_key_hash": "b" * 64, "request_fingerprint": "c" * 64,
            }, daily_limit=3, max_concurrent=3, utc_day="2026-11-20")
            self.assertEqual(store.daily_usage("2026-11-20"), 1)
            removed = store.prune_completed(max_jobs=50, retain_jobs=40)
            self.assertTrue(removed)
            self.assertEqual(store.daily_usage("2026-11-20"), 1)

if __name__ == "__main__":
    unittest.main()
