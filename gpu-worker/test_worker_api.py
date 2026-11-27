from __future__ import annotations

import importlib
import json
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
from fastapi.testclient import TestClient


class _FakeCuda:
    @staticmethod
    def is_available() -> bool:
        return True

    @staticmethod
    def get_device_properties(_index: int):
        return types.SimpleNamespace(total_memory=16 * 1024**3)

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
    os.environ["ZERO_VIDEO_ENGINE_TOKEN"] = "ci-worker-token-0123456789abcdef"
    os.environ["ZERO_WAN_GPU_ENABLED"] = "true"
    os.environ["ZERO_WAN_GPU_COSTS_CONFIRMED"] = "true"
    os.environ["ZERO_WAN_GPU_DAILY_JOB_LIMIT"] = "3"
    sys.path.insert(0, str(Path(__file__).parent))
    _install_runtime_stubs()
    worker = importlib.import_module("app")


class WanWorkerApiSecurityTests(unittest.TestCase):
    PRINCIPAL_A = "a" * 64
    PRINCIPAL_B = "e" * 64

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="zero-wan-api-test-")
        self.output = Path(self.temp.name)
        worker.OUTPUT_DIR = self.output
        worker._JOB_STORE = worker.PersistentJobStore(self.output)
        worker._jobs = worker._JOB_STORE.load_all()
        worker.PERSISTENT_MOUNT_CONFIGURED = True
        worker.MODEL_CACHE_PERSISTENT = True
        worker.APP_TOKEN = "ci-worker-token-0123456789abcdef"
        worker.WAN_GPU_ENABLED = True
        worker.WAN_GPU_COSTS_CONFIRMED = True
        worker.WAN_DAILY_JOB_LIMIT = 3
        worker.WAN_MAX_CONCURRENT_JOBS = 1
        worker.gpu_vram_total_mb = lambda: 16 * 1024
        self.auth = "Bearer ci-worker-token-0123456789abcdef"
        self.client = TestClient(worker.app)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def headers(self, principal: str, key: str = "b" * 64) -> dict[str, str]:
        return {
            "Authorization": self.auth,
            "X-Zero-Principal-Hash": principal,
            "Idempotency-Key": key,
        }

    def payload(self) -> dict[str, object]:
        return {
            "prompt": "A cinematic five second test scene",
            "duration_sec": 5,
            "aspect_ratio": "9:16",
            "project_id": "project_123",
            "scene_id": "scene_456",
        }

    def create_http(self, principal: str = PRINCIPAL_A, key: str = "b" * 64):
        with patch.object(worker, "run_generation", return_value=None):
            return self.client.post("/jobs", json=self.payload(), headers=self.headers(principal, key))

    def test_authentication_cost_gate_gpu_gate_and_principal_are_required(self) -> None:
        configured_token = worker.APP_TOKEN
        try:
            worker.APP_TOKEN = "short"
            self.assertEqual(
                self.client.get("/jobs", headers={"Authorization": "Bearer short"}).status_code,
                503,
            )
            self.assertEqual(self.client.get("/health").status_code, 503)
            worker.APP_TOKEN = "example-do-not-use-this-token-000000"
            self.assertEqual(
                self.client.get("/jobs", headers={"Authorization": "Bearer example-do-not-use-this-token-000000"}).status_code,
                503,
            )
        finally:
            worker.APP_TOKEN = configured_token
        self.assertEqual(self.client.get("/jobs").status_code, 401)
        missing_principal = self.client.get("/jobs", headers={"Authorization": self.auth})
        self.assertEqual(missing_principal.status_code, 401)

        worker.WAN_GPU_ENABLED = False
        blocked_enabled = self.create_http(key="c" * 64)
        self.assertEqual(blocked_enabled.status_code, 403)
        self.assertEqual(worker._JOB_STORE.daily_usage(), 0)

        worker.WAN_GPU_ENABLED = True
        worker.WAN_GPU_COSTS_CONFIRMED = False
        blocked_cost = self.create_http(key="d" * 64)
        self.assertEqual(blocked_cost.status_code, 403)
        self.assertEqual(worker._JOB_STORE.daily_usage(), 0)

        worker.WAN_GPU_COSTS_CONFIRMED = True
        worker.gpu_vram_total_mb = lambda: 8 * 1024
        blocked_gpu = self.create_http(key="f" * 64)
        self.assertEqual(blocked_gpu.status_code, 503)
        self.assertEqual(worker._JOB_STORE.daily_usage(), 0)

    def test_job_list_status_video_and_cancel_are_scoped_to_principal_hash(self) -> None:
        created_response = self.create_http()
        self.assertEqual(created_response.status_code, 202, created_response.text)
        created = created_response.json()["job"]
        job_id = created["id"]
        self.assertEqual(created["status"], "queued")

        owner_list = self.client.get("/jobs?project_id=project_123", headers=self.headers(self.PRINCIPAL_A))
        other_list = self.client.get("/jobs?project_id=project_123", headers=self.headers(self.PRINCIPAL_B))
        self.assertEqual(owner_list.status_code, 200)
        self.assertEqual([job["id"] for job in owner_list.json()["jobs"]], [job_id])
        self.assertEqual(other_list.status_code, 200)
        self.assertEqual(other_list.json()["jobs"], [])

        self.assertEqual(self.client.get(f"/jobs/{job_id}", headers=self.headers(self.PRINCIPAL_B)).status_code, 404)
        self.assertEqual(self.client.get(f"/jobs/{job_id}/video", headers=self.headers(self.PRINCIPAL_B)).status_code, 404)
        self.assertEqual(self.client.post(f"/jobs/{job_id}/cancel", headers=self.headers(self.PRINCIPAL_B)).status_code, 404)

        cancelled = self.client.post(f"/jobs/{job_id}/cancel", headers=self.headers(self.PRINCIPAL_A))
        self.assertEqual(cancelled.status_code, 200, cancelled.text)
        self.assertEqual(cancelled.json()["status"], "cancelled")
        self.assertTrue(cancelled.json()["cancelled"])
        self.assertEqual(self.client.get(f"/jobs/{job_id}", headers=self.headers(self.PRINCIPAL_A)).json()["status"], "cancelled")
        self.assertEqual(self.client.get(f"/jobs/{job_id}/video", headers=self.headers(self.PRINCIPAL_A)).status_code, 409)

    def test_running_cancel_keeps_gpu_slot_reserved_until_inference_stops(self) -> None:
        created = self.create_http().json()["job"]
        job_id = created["id"]
        running = dict(worker._jobs[job_id], status="running")
        worker._jobs[job_id] = running
        worker._JOB_STORE.save(running)

        response = self.client.post(f"/jobs/{job_id}/cancel", headers=self.headers(self.PRINCIPAL_A))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "cancel_requested")
        self.assertTrue(response.json()["cancel_requested"])

        blocked = self.create_http(principal=self.PRINCIPAL_B, key="c" * 64)
        self.assertEqual(blocked.status_code, 429)
        self.assertEqual(worker._JOB_STORE.daily_usage(), 1)

        worker.run_generation(job_id, "A cinematic five second test scene", "9:16", None)
        self.assertEqual(worker._jobs[job_id]["status"], "cancelled")

    def test_idempotency_replays_before_queue_cost_and_gpu_admission(self) -> None:
        first = self.create_http(principal=self.PRINCIPAL_A, key="1" * 64)
        self.assertEqual(first.status_code, 202)
        first_id = first.json()["job"]["id"]

        # Fill the in-memory queue after the job was accepted. A retry must
        # replay the original durable job rather than being rejected as new.
        for _ in range(49):
            fake_id = str(UUID(int=1000 + _))
            worker._jobs[fake_id] = {
                "id": fake_id, "status": "completed", "created_at": "2026-11-18T12:00:00Z",
                "duration_sec": 5, "engine": "Wan 2.1", "project_id": "project_123",
                "scene_id": "scene_456", "principal_hash": self.PRINCIPAL_A,
                "idempotency_key_hash": str(_).zfill(64), "request_fingerprint": str(_).zfill(64),
            }
        self.assertEqual(len(worker._jobs), 50)

        # Closing the gate or losing GPU capacity after acceptance must not
        # prevent a read-only replay; it must never start a second inference.
        worker.WAN_GPU_ENABLED = False
        worker.WAN_GPU_COSTS_CONFIRMED = False
        worker.gpu_vram_total_mb = lambda: 0
        replay = self.create_http(principal=self.PRINCIPAL_A, key="1" * 64)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.json()["job"]["id"], first_id)
        self.assertTrue(replay.json()["replayed"])
        worker.WAN_GPU_ENABLED = True
        worker.WAN_GPU_COSTS_CONFIRMED = True
        worker.gpu_vram_total_mb = lambda: 16 * 1024

        other_principal = self.create_http(principal=self.PRINCIPAL_B, key="1" * 64)
        self.assertEqual(other_principal.status_code, 429)  # A different principal cannot replay the accepted job.

        changed_payload = self.payload()
        changed_payload["prompt"] = "A different cinematic five second test scene"
        with patch.object(worker, "run_generation", return_value=None):
            conflict = self.client.post("/jobs", json=changed_payload, headers=self.headers(self.PRINCIPAL_A, "1" * 64))
        self.assertEqual(conflict.status_code, 409)

    def test_cancelled_and_cancel_requested_jobs_recover_safely_after_restart(self) -> None:
        queued = self.create_http(key="2" * 64).json()["job"]
        queued_cancel = worker._JOB_STORE.request_cancel(queued["id"], self.PRINCIPAL_A)
        self.assertEqual(queued_cancel["status"], "cancelled")

        running = dict(queued, id="00000000-0000-4000-8000-000000000077", status="running", principal_hash=self.PRINCIPAL_A, idempotency_key_hash="3" * 64, request_fingerprint="4" * 64)
        worker._JOB_STORE.create_or_get(running)
        requested = worker._JOB_STORE.request_cancel(running["id"], self.PRINCIPAL_A)
        self.assertEqual(requested["status"], "cancel_requested")

        restarted = worker.PersistentJobStore(self.output)
        recovered = restarted.load_all()
        self.assertEqual(recovered[queued["id"]]["status"], "cancelled")
        self.assertEqual(recovered[running["id"]]["status"], "cancelled")

    def test_daily_job_limit_parser_clamps_to_reviewed_ceiling_and_fails_closed(self) -> None:
        self.assertEqual(worker.WAN_MAX_DAILY_JOBS, 15)
        self.assertEqual(worker.WAN_MAX_PROJECT_JOBS_PER_DAY, 3)
        self.assertEqual(worker.parse_daily_job_limit(None), 3)
        self.assertEqual(worker.parse_daily_job_limit("0"), 0)
        self.assertEqual(worker.parse_daily_job_limit("3"), 3)
        self.assertEqual(worker.parse_daily_job_limit("15"), 15)
        self.assertEqual(worker.parse_daily_job_limit("16"), 15)
        self.assertEqual(worker.parse_daily_job_limit("-1"), 0)
        self.assertEqual(worker.parse_daily_job_limit("invalid"), 0)
        self.assertEqual(worker.parse_daily_job_limit(""), 0)

    def test_worker_health_reports_free_only_gate_and_sixty_second_cap(self) -> None:
        worker.WAN_DAILY_JOB_LIMIT = 15
        status = worker.health()
        self.assertTrue(status["cost_gate_open"])
        self.assertEqual(status["daily_job_limit"], 15)
        self.assertEqual(status["daily_jobs_remaining"], 15)
        self.assertEqual(status["max_concurrent_jobs"], 1)
        self.assertEqual(status["max_shot_duration_sec"], 5)
        self.assertEqual(status["max_final_duration_sec"], 60)
        self.assertFalse(status["cost_fallback"])

    def test_authenticated_completed_mp4_is_only_visible_to_owning_principal(self) -> None:
        video_id = str(UUID("00000000-0000-4000-8000-000000000099"))
        video_path = self.output / f"{video_id}.mp4"
        video_path.write_bytes(b"ZERO-CI-MP4" + bytes(4096))
        completed = {
            "id": video_id, "status": "succeeded", "created_at": "2026-11-18T12:00:00Z",
            "duration_sec": 5, "filename": video_path.name, "project_id": "project_123",
            "scene_id": "scene_456", "principal_hash": self.PRINCIPAL_A,
            "idempotency_key_hash": "4" * 64, "request_fingerprint": "5" * 64,
        }
        worker._JOB_STORE.save(completed)
        worker._jobs[video_id] = dict(completed)
        owner = self.client.get(f"/jobs/{video_id}/video", headers=self.headers(self.PRINCIPAL_A))
        other = self.client.get(f"/jobs/{video_id}/video", headers=self.headers(self.PRINCIPAL_B))
        self.assertEqual(owner.status_code, 200)
        self.assertEqual(owner.headers["content-type"], "video/mp4")
        self.assertEqual(owner.content[:11], b"ZERO-CI-MP4")
        self.assertEqual(other.status_code, 404)


if __name__ == "__main__":
    unittest.main()
