from __future__ import annotations

import importlib
import os
import sys
import tempfile
import types
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

from fastapi import BackgroundTasks, HTTPException


# The worker API tests exercise real FastAPI route functions and SQLite state,
# while replacing CUDA/Diffusers so CI never downloads weights or runs inference.
class _FakeCuda:
    @staticmethod
    def is_available() -> bool:
        return True

    @staticmethod
    def get_device_properties(_index: int):
        return types.SimpleNamespace(total_memory=16 * 1024**3)

    @staticmethod
    def get_device_name(_index: int) -> str:
        return "CI fake GPU (no inference)"

    @staticmethod
    def mem_get_info(_index: int):
        return 8 * 1024**3, 16 * 1024**3


class _FakeGenerator:
    def __init__(self, device: str):
        self.device = device

    def manual_seed(self, seed: int):
        self.seed = seed
        return self


def _install_runtime_stubs() -> None:
    torch = types.ModuleType("torch")
    torch.cuda = _FakeCuda()
    torch.Generator = _FakeGenerator
    torch.inference_mode = nullcontext
    diffusers = types.ModuleType("diffusers")
    diffusers.WanPipeline = object
    diffusers_utils = types.ModuleType("diffusers.utils")
    diffusers_utils.export_to_video = lambda *_args, **_kwargs: None
    sys.modules["torch"] = torch
    sys.modules["diffusers"] = diffusers
    sys.modules["diffusers.utils"] = diffusers_utils


with tempfile.TemporaryDirectory(prefix="zero-wan-api-import-") as _import_root:
    os.environ["WAN_OUTPUT_DIR"] = _import_root
    os.environ["HF_HOME"] = str(Path(_import_root) / "hf-cache")
    os.environ["ZERO_VIDEO_ENGINE_TOKEN"] = "ci-worker-token"
    os.environ["ZERO_WAN_GPU_ENABLED"] = "true"
    os.environ["ZERO_WAN_GPU_COSTS_CONFIRMED"] = "true"
    os.environ["ZERO_WAN_GPU_DAILY_JOB_LIMIT"] = "3"
    sys.path.insert(0, str(Path(__file__).parent))
    _install_runtime_stubs()
    worker = importlib.import_module("app")


class WanWorkerApiLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="zero-wan-api-test-")
        self.output = Path(self.temp.name)
        worker.OUTPUT_DIR = self.output
        worker._JOB_STORE = worker.PersistentJobStore(self.output)
        worker._jobs = worker._JOB_STORE.load_all()
        worker.PERSISTENT_MOUNT_CONFIGURED = True
        worker.MODEL_CACHE_PERSISTENT = True
        worker.APP_TOKEN = "ci-worker-token"
        worker.WAN_GPU_ENABLED = True
        worker.WAN_GPU_COSTS_CONFIRMED = True
        worker.WAN_DAILY_JOB_LIMIT = 3
        worker.WAN_MAX_CONCURRENT_JOBS = 1
        worker.gpu_vram_total_mb = lambda: 16 * 1024
        self.auth = "Bearer ci-worker-token"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def create(self, job_id: str | None = None):
        tasks = BackgroundTasks()
        fixed = UUID(job_id) if job_id else UUID("00000000-0000-4000-8000-000000000001")
        with patch.object(worker.uuid, "uuid4", return_value=fixed):
            result = worker.create_job(
                worker.GenerateRequest(
                    prompt="A cinematic five second test scene",
                    duration_sec=5,
                    aspect_ratio="9:16",
                    project_id="project_123",
                    scene_id="scene_456",
                ),
                tasks,
                authorization=self.auth,
            )
        return result, tasks

    def test_authentication_cost_gate_and_gpu_gate_fail_closed(self) -> None:
        with self.assertRaises(HTTPException) as unauthorized:
            worker.list_jobs(50, authorization=None)
        self.assertEqual(unauthorized.exception.status_code, 401)

        worker.WAN_GPU_ENABLED = False
        with self.assertRaises(HTTPException) as cost_blocked:
            self.create()
        self.assertEqual(cost_blocked.exception.status_code, 403)
        self.assertEqual(worker._JOB_STORE.daily_usage(), 0)

        worker.WAN_GPU_ENABLED = True
        worker.gpu_vram_total_mb = lambda: 8 * 1024
        with self.assertRaises(HTTPException) as gpu_blocked:
            self.create()
        self.assertEqual(gpu_blocked.exception.status_code, 503)
        self.assertEqual(worker._JOB_STORE.daily_usage(), 0)

    def test_authenticated_create_persists_job_and_project_scene_metadata(self) -> None:
        created, tasks = self.create()
        job_id = created["id"]
        self.assertEqual(created["status"], "queued")
        self.assertEqual(created["duration_sec"], 5)
        self.assertEqual(len(tasks.tasks), 1)

        listed = worker.list_jobs(50, authorization=self.auth)["jobs"]
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["id"], job_id)
        self.assertEqual(listed[0]["status"], "queued")
        self.assertEqual(listed[0]["project_id"], "project_123")
        self.assertEqual(listed[0]["scene_id"], "scene_456")
        self.assertEqual(worker.get_job(job_id, authorization=self.auth)["status"], "queued")

        # A fresh store instance represents a worker process restart.
        restarted = worker.PersistentJobStore(self.output)
        self.assertEqual(restarted.list_jobs()[0]["id"], job_id)
        self.assertEqual(restarted.load_all()[job_id]["status"], "failed")

    def test_all_six_lifecycle_states_are_returned_by_persistent_list(self) -> None:
        states = ["queued", "running", "cancel_requested", "cancelled", "succeeded", "failed"]
        for index, status in enumerate(states, start=1):
            job_id = str(UUID(int=index))
            worker._JOB_STORE.save({
                "id": job_id,
                "status": status,
                "created_at": f"2026-11-18T12:0{index}:00Z",
                "duration_sec": 5,
                "project_id": "project_123",
                "scene_id": "scene_456",
            })
        listed = worker.list_jobs(50, authorization=self.auth)["jobs"]
        self.assertEqual({job["status"] for job in listed}, set(states))
        self.assertEqual(len(listed), 6)

    def test_queued_cancel_is_final_and_survives_restart(self) -> None:
        created, _ = self.create()
        job_id = created["id"]
        cancelled = worker.cancel_job(job_id, authorization=self.auth)
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertTrue(cancelled["cancelled"])
        self.assertEqual(worker.PersistentJobStore(self.output).load_all()[job_id]["status"], "cancelled")

    def test_worker_health_and_api_preserve_five_second_shots_and_sixty_second_final_cap(self) -> None:
        status = worker.health()
        self.assertEqual(status["max_shot_duration_sec"], 5)
        self.assertEqual(status["max_final_duration_sec"], 60)
        self.assertFalse(status["cost_fallback"])

    def test_daily_limit_is_enforced_by_create_endpoint_after_terminal_jobs(self) -> None:
        for index in range(3):
            job_id = str(UUID(int=100 + index))
            self.create(job_id)
            worker._jobs[job_id]["status"] = "failed"
            worker._JOB_STORE.save(worker._jobs[job_id])
        self.assertEqual(worker._JOB_STORE.daily_usage(), 3)
        with self.assertRaises(HTTPException) as limited:
            self.create(str(UUID(int=104)))
        self.assertEqual(limited.exception.status_code, 429)
        self.assertEqual(worker._JOB_STORE.daily_usage(), 3)

    def test_running_cancel_is_only_requested_and_keeps_gpu_concurrency_reserved(self) -> None:
        job_id = str(UUID("00000000-0000-4000-8000-000000000010"))
        job = {"id": job_id, "status": "running", "created_at": "2026-11-18T12:00:00Z"}
        worker._JOB_STORE.save(job)
        worker._jobs[job_id] = dict(job)

        result = worker.cancel_job(job_id, authorization=self.auth)
        self.assertEqual(result["status"], "cancel_requested")
        self.assertFalse(result["cancelled"])
        self.assertTrue(result["cancel_requested"])

        allowed, reason, _ = worker._JOB_STORE.create_job_if_allowed(
            {"id": "another-job", "status": "queued"},
            daily_limit=3,
            max_concurrent=1,
            utc_day="2026-11-18",
        )
        self.assertFalse(allowed)
        self.assertEqual(reason, "concurrency_limit")
        with self.assertRaises(HTTPException) as endpoint_blocked:
            self.create(str(UUID("00000000-0000-4000-8000-000000000011")))
        self.assertEqual(endpoint_blocked.exception.status_code, 429)

    def test_cancelled_job_never_exposes_mp4_and_terminal_cancel_is_idempotent(self) -> None:
        created, _ = self.create()
        job_id = created["id"]
        result = worker.cancel_job(job_id, authorization=self.auth)
        self.assertEqual(result["status"], "cancelled")
        with self.assertRaises(HTTPException) as not_ready:
            worker.get_video(job_id, authorization=self.auth)
        self.assertEqual(not_ready.exception.status_code, 409)
        self.assertEqual(worker.cancel_job(job_id, authorization=self.auth)["status"], "cancelled")

    def test_completed_mp4_is_restorable_after_restart_with_original_scene_metadata(self) -> None:
        created, _ = self.create()
        job_id = created["id"]

        class FakePipeline:
            def __call__(self, **_kwargs):
                return types.SimpleNamespace(frames=[["frame"]])

        worker.get_pipeline = lambda: FakePipeline()
        def write_fake_mp4(_frames, filename: str, fps: int = 16) -> None:
            Path(filename).write_bytes(b"ZERO-CI-MP4" + bytes(4096))
        worker.export_to_video = write_fake_mp4

        worker.run_generation(job_id, "A cinematic five second test scene", "9:16", None)
        completed = worker.get_job(job_id, authorization=self.auth)
        self.assertEqual(completed["status"], "succeeded")
        self.assertEqual(completed["project_id"], "project_123")
        self.assertEqual(completed["scene_id"], "scene_456")

        restarted = worker.PersistentJobStore(self.output)
        restored_jobs = restarted.load_all()
        worker._JOB_STORE = restarted
        worker._jobs = restored_jobs
        restored = restored_jobs[job_id]
        self.assertEqual(restored["status"], "succeeded")
        self.assertEqual(restored["project_id"], "project_123")
        self.assertEqual(restored["scene_id"], "scene_456")
        response = worker.get_video(job_id, authorization=self.auth)
        self.assertEqual(Path(response.path).read_bytes()[:11], b"ZERO-CI-MP4")

    def test_missing_mp4_and_path_traversal_are_marked_failed_on_restart(self) -> None:
        missing_id = str(UUID("00000000-0000-4000-8000-000000000020"))
        traversal_id = str(UUID("00000000-0000-4000-8000-000000000021"))
        outside = self.output.parent / "zero-wan-outside-test.mp4"
        outside.write_bytes(bytes(2048))
        try:
            worker._JOB_STORE.save({
                "id": missing_id, "status": "succeeded", "filename": "missing.mp4",
            })
            worker._JOB_STORE.save({
                "id": traversal_id, "status": "succeeded", "filename": "../zero-wan-outside-test.mp4",
            })
            recovered = worker.PersistentJobStore(self.output).load_all()
            self.assertEqual(recovered[missing_id]["status"], "failed")
            self.assertIn("MP4 fehlt", recovered[missing_id]["error"])
            self.assertEqual(recovered[traversal_id]["status"], "failed")
            with self.assertRaises(HTTPException) as missing_video:
                worker.get_video(missing_id, authorization=self.auth)
            self.assertEqual(missing_video.exception.status_code, 409)
        finally:
            outside.unlink(missing_ok=True)

    def test_duplicate_job_id_returns_conflict_without_consuming_daily_quota(self) -> None:
        fixed_id = "00000000-0000-4000-8000-000000000030"
        first, _ = self.create(fixed_id)
        worker._jobs[first["id"]]["status"] = "failed"
        worker._JOB_STORE.save(worker._jobs[first["id"]])
        before = worker._JOB_STORE.daily_usage()
        with self.assertRaises(HTTPException) as duplicate:
            self.create(fixed_id)
        self.assertEqual(duplicate.exception.status_code, 409)
        self.assertEqual(worker._JOB_STORE.daily_usage(), before)

    def test_daily_quota_and_retention_survive_job_history_cleanup(self) -> None:
        store = worker._JOB_STORE
        for index in range(3):
            allowed, _, _ = store.create_job_if_allowed(
                {"id": f"quota-job-{index}", "status": "failed", "created_at": f"2026-11-18T12:0{index}:00Z"},
                daily_limit=3,
                max_concurrent=3,
                utc_day="2026-11-18",
            )
            self.assertTrue(allowed)
        before = store.daily_usage("2026-11-18")
        self.assertEqual(before, 3)

        for index in range(50):
            store.save({
                "id": f"retention-{index}",
                "status": "cancelled" if index == 0 else "failed",
                "created_at": f"2026-11-{1 + (index % 17):02d}T00:00:00Z",
            })
        removed = store.prune_completed(max_jobs=50, retain_jobs=40)
        self.assertTrue(removed)
        self.assertEqual(store.daily_usage("2026-11-18"), 3)
        self.assertEqual(len(store.list_jobs(50)), 40)

    def test_corrupt_persisted_json_is_ignored_by_job_list(self) -> None:
        import sqlite3
        with sqlite3.connect(worker._JOB_STORE.database_path) as connection:
            connection.execute(
                "INSERT INTO zero_video_jobs (id, payload) VALUES (?, ?)",
                ("corrupt-job", "{not-json"),
            )
        self.assertEqual(worker.list_jobs(50, authorization=self.auth)["jobs"], [])


if __name__ == "__main__":
    unittest.main()
