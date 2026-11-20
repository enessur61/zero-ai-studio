from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from job_store import (
    PersistentJobStore,
    has_persistent_mount,
    has_sufficient_gpu_memory,
    require_persistent_storage,
)


class PersistentJobStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.store = PersistentJobStore(self.root / "output")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @staticmethod
    def _job(
        job_id: str,
        *,
        principal: str = "principal-a",
        key: str | None = None,
        fingerprint: str | None = None,
        project_id: str = "project-a",
        status: str = "queued",
        created_at: str = "2026-11-20T00:00:00Z",
        **extra: object,
    ) -> dict[str, object]:
        raw_key = key or f"idempotency-{job_id}"
        return {
            "id": job_id,
            "kind": "video",
            "status": status,
            "project_id": project_id,
            "principal_hash": principal,
            "idempotency_key_hash": hashlib.sha256(raw_key.encode()).hexdigest(),
            "request_fingerprint": fingerprint or hashlib.sha256(job_id.encode()).hexdigest(),
            "created_at": created_at,
            "updated_at": created_at,
            **extra,
        }

    def test_persistent_mount_uses_longest_matching_mount(self) -> None:
        mountinfo = (
            "36 25 0:32 / / rw,relatime - overlay overlay rw\n"
            "37 36 8:1 / /mnt/persistent rw,relatime - ext4 /dev/sda1 rw\n"
            "38 37 8:2 / /mnt/persistent/output rw,relatime - xfs /dev/sdb1 rw\n"
        )
        self.assertTrue(has_persistent_mount("/mnt/persistent/output/jobs", mountinfo))
        self.assertFalse(has_persistent_mount("/tmp/jobs", mountinfo))

    def test_require_persistent_storage_rejects_ephemeral_disk(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "persistent"):
            require_persistent_storage(False)
        require_persistent_storage(True)

    def test_gpu_memory_guard_uses_megabytes_and_enforces_12_gib(self) -> None:
        self.assertFalse(has_sufficient_gpu_memory(8 * 1024))
        self.assertFalse(has_sufficient_gpu_memory(12 * 1024 - 1))
        self.assertTrue(has_sufficient_gpu_memory(12 * 1024))
        self.assertTrue(has_sufficient_gpu_memory(24 * 1024))

    def test_limited_create_is_idempotent_principal_scoped_and_atomic(self) -> None:
        first = self._job("job-1", key="shared-key", fingerprint="fingerprint-a")
        created, replayed, conflict, error, accepted = self.store.create_or_get_limited(
            first, daily_limit=2, max_concurrent=1, utc_day="2026-11-20"
        )
        self.assertEqual(created, first)
        self.assertFalse(replayed)
        self.assertFalse(conflict)
        self.assertIsNone(error)
        self.assertEqual(accepted, 1)
        self.assertEqual(self.store.daily_usage("2026-11-20"), 1)

        replay, replayed, conflict, error, accepted = self.store.create_or_get_limited(
            first, daily_limit=2, max_concurrent=1, utc_day="2026-11-20"
        )
        self.assertEqual(replay, first)
        self.assertTrue(replayed)
        self.assertFalse(conflict)
        self.assertIsNone(error)
        self.assertEqual(accepted, 1)

        changed_payload = self._job("job-1-retry", key="shared-key", fingerprint="different-fingerprint")
        replay, replayed, conflict, error, accepted = self.store.create_or_get_limited(
            changed_payload, daily_limit=2, max_concurrent=1, utc_day="2026-11-20"
        )
        self.assertEqual(replay, first)
        self.assertTrue(replayed)
        self.assertTrue(conflict)
        self.assertIsNone(error)
        self.assertEqual(accepted, 1)

        blocked = self._job("job-2", key="second-key")
        job, replayed, conflict, error, accepted = self.store.create_or_get_limited(
            blocked, daily_limit=2, max_concurrent=1, utc_day="2026-11-20"
        )
        self.assertIsNone(job)
        self.assertFalse(replayed)
        self.assertFalse(conflict)
        self.assertEqual(error, "concurrency_limit")
        self.assertEqual(accepted, 1)

        completed = dict(first, status="succeeded", finished_at="2026-11-20T00:01:00Z")
        self.store.save(completed)
        created, replayed, conflict, error, accepted = self.store.create_or_get_limited(
            blocked, daily_limit=2, max_concurrent=1, utc_day="2026-11-20"
        )
        self.assertEqual(created, blocked)
        self.assertFalse(replayed)
        self.assertFalse(conflict)
        self.assertIsNone(error)
        self.assertEqual(accepted, 2)

        over_limit = self._job("job-3", key="third-key")
        job, replayed, conflict, error, accepted = self.store.create_or_get_limited(
            over_limit, daily_limit=2, max_concurrent=2, utc_day="2026-11-20"
        )
        self.assertIsNone(job)
        self.assertEqual(error, "daily_limit")
        self.assertEqual(accepted, 2)
        self.assertEqual(self.store.daily_usage("2026-11-20"), 2)

        # The same idempotency key is isolated by principal.
        other_principal = self._job("job-4", principal="principal-b", key="shared-key")
        created, replayed, conflict, error, accepted = self.store.create_or_get_limited(
            other_principal, daily_limit=3, max_concurrent=2, utc_day="2026-11-20"
        )
        self.assertEqual(created, other_principal)
        self.assertFalse(replayed)
        self.assertFalse(conflict)
        self.assertIsNone(error)
        self.assertEqual(accepted, 3)

    def test_cancel_requires_matching_principal(self) -> None:
        queued = self._job("queued-job")
        self.store.save(queued)
        self.assertIsNone(self.store.request_cancel("queued-job", "principal-b"))
        cancelled = self.store.request_cancel("queued-job", "principal-a")
        self.assertIsNotNone(cancelled)
        self.assertEqual(cancelled["status"], "cancelled")

        running = self._job("running-job", status="running")
        self.store.save(running)
        cancel_requested = self.store.request_cancel("running-job", "principal-a")
        self.assertIsNotNone(cancel_requested)
        self.assertEqual(cancel_requested["status"], "cancel_requested")

    def test_list_jobs_is_scoped_by_principal_and_project(self) -> None:
        self.store.save(self._job("a1", project_id="project-a"))
        self.store.save(self._job("a2", project_id="project-b"))
        self.store.save(self._job("b1", principal="principal-b", project_id="project-a"))
        self.store.save(self._job("deleting", status="deleting"))

        principal_a = self.store.list_by_principal("principal-a")
        self.assertEqual({job["id"] for job in principal_a}, {"a1", "a2"})
        project_a = self.store.list_by_principal("principal-a", project_id="project-a")
        self.assertEqual([job["id"] for job in project_a], ["a1"])

    def test_project_deletion_marks_active_jobs_and_removes_terminal_jobs(self) -> None:
        active = self._job("active", project_id="project-a", status="running")
        terminal = self._job("terminal", project_id="project-a", status="succeeded")
        other_project = self._job("other", project_id="project-b", status="running")
        other_principal = self._job("foreign", principal="principal-b", project_id="project-a", status="running")
        for job in (active, terminal, other_project, other_principal):
            self.store.save(job)

        affected = self.store.mark_project_jobs_for_deletion("principal-a", "project-a")
        by_id = {job["id"]: job for job in affected}
        self.assertEqual(set(by_id), {"active", "terminal"})
        self.assertEqual(by_id["active"]["status"], "deleting")
        self.assertEqual(by_id["terminal"]["status"], "succeeded")
        self.assertEqual(
            {job["id"] for job in self.store.list_by_principal("principal-a")},
            {"other"},
        )

        # Startup cleanup removes the deferred active job and its file safely.
        output = self.store.output_dir
        filename = output / "active.mp4"
        filename.write_bytes(b"test")
        self.store.save(dict(active, status="deleting", filename=filename.name))
        self.store.load_all()
        self.assertFalse(filename.exists())
        self.assertEqual(
            {job["id"] for job in self.store.list_by_principal("principal-a")},
            {"other"},
        )

    def test_load_all_recovers_interrupted_and_missing_artifact_jobs(self) -> None:
        self.store.save(self._job("queued", status="queued"))
        self.store.save(self._job("running", status="running"))
        self.store.save(self._job("cancel", status="cancel_requested"))
        self.store.save(self._job("missing", status="succeeded", filename="missing.mp4"))
        deleting_file = self.store.output_dir / "delete-me.mp4"
        deleting_file.write_bytes(b"test")
        self.store.save(self._job("deleting", status="deleting", filename=deleting_file.name))

        recovered = self.store.load_all()
        self.assertEqual(recovered["queued"]["status"], "failed")
        self.assertEqual(recovered["running"]["status"], "failed")
        self.assertEqual(recovered["cancel"]["status"], "cancelled")
        self.assertEqual(recovered["missing"]["status"], "failed")
        self.assertNotIn("deleting", recovered)
        self.assertFalse(deleting_file.exists())

    def test_prune_completed_retains_only_requested_recent_jobs(self) -> None:
        for index in range(3):
            self.store.save(self._job(
                f"completed-{index}",
                status="succeeded",
                created_at=f"2026-11-20T00:0{index}:00Z",
            ))
        removed = self.store.prune_completed(max_jobs=3, retain_jobs=1)
        self.assertEqual({job["id"] for job in removed}, {"completed-0", "completed-1"})
        remaining = self.store.list_by_principal("principal-a")
        self.assertEqual([job["id"] for job in remaining], ["completed-2"])


if __name__ == "__main__":
    unittest.main()
