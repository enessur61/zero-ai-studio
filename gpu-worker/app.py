from __future__ import annotations

import asyncio
import hmac
import hashlib
import json
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

from job_store import PersistentJobStore, has_persistent_mount, has_sufficient_gpu_memory, require_persistent_storage

import torch
from diffusers import WanPipeline
from diffusers.utils import export_to_video
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

APP_TOKEN = os.environ.get("ZERO_VIDEO_ENGINE_TOKEN", "")
MODEL_ID = os.environ.get("WAN_MODEL_ID", "Wan-AI/Wan2.1-T2V-1.3B-Diffusers")
OUTPUT_DIR = Path(os.environ.get("WAN_OUTPUT_DIR", "/tmp/zero-wan-jobs")).resolve()
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
HF_CACHE_DIR = Path(os.environ.get("HF_HOME", "/data/huggingface-cache")).resolve()
HF_CACHE_DIR.mkdir(parents=True, exist_ok=True)

PERSISTENT_MOUNT_CONFIGURED = has_persistent_mount(OUTPUT_DIR)
MODEL_CACHE_PERSISTENT = has_persistent_mount(HF_CACHE_DIR)
WAN_REQUIRE_PERSISTENT_STORAGE = os.environ.get("WAN_REQUIRE_PERSISTENT_STORAGE", "false").lower() == "true"
if WAN_REQUIRE_PERSISTENT_STORAGE and not (PERSISTENT_MOUNT_CONFIGURED and MODEL_CACHE_PERSISTENT):
    require_persistent_storage(False)

WAN_GPU_ENABLED = os.environ.get("ZERO_WAN_GPU_ENABLED", "false").lower() == "true"
WAN_GPU_COSTS_CONFIRMED = os.environ.get("ZERO_WAN_GPU_COSTS_CONFIRMED", "false").lower() == "true"
# Up to five 60-second episodes can each use at most three 5-second Wan shots.
# Keep the conservative default at three jobs; operators may raise it only
# after verifying their own GPU capacity and non-billable hosting.
WAN_MAX_DAILY_JOBS = 15
try:
    WAN_DAILY_JOB_LIMIT = max(0, min(int(os.environ.get("ZERO_WAN_GPU_DAILY_JOB_LIMIT", "3")), WAN_MAX_DAILY_JOBS))
except (TypeError, ValueError):
    WAN_DAILY_JOB_LIMIT = 0
WAN_MAX_CONCURRENT_JOBS = 1

_JOB_STORE = PersistentJobStore(OUTPUT_DIR)

app = FastAPI(title="ZERO Wan GPU Worker", version="0.2.0")
_jobs: dict[str, dict[str, Any]] = _JOB_STORE.load_all()
_jobs_lock = Lock()
_generation_lock = Lock()
_pipeline: WanPipeline | None = None


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=8, max_length=1800)
    # One Wan shot is deliberately capped at 5 seconds. ZERO assembles shots
    # into a final timeline that is independently hard-capped at 60 seconds.
    duration_sec: int = Field(default=5, ge=5, le=5)
    aspect_ratio: str = Field(default="16:9", pattern="^(16:9|9:16)$")
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)
    project_id: str = Field(min_length=1, max_length=128)
    scene_id: str = Field(min_length=1, max_length=128)


def require_auth(authorization: str | None) -> None:
    if not APP_TOKEN:
        raise HTTPException(status_code=503, detail="Worker auth is not configured")
    supplied = authorization.removeprefix("Bearer ").strip() if authorization else ""
    if not hmac.compare_digest(supplied, APP_TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")


def require_cost_gate() -> None:
    if not WAN_GPU_ENABLED or not WAN_GPU_COSTS_CONFIRMED:
        raise HTTPException(status_code=403, detail="Wan GPU execution requires both explicit ZERO cost confirmations.")
    if WAN_DAILY_JOB_LIMIT < 1:
        raise HTTPException(status_code=503, detail="Wan daily job limit is not configured.")


def gpu_vram_total_mb() -> int:
    if not torch.cuda.is_available():
        return 0
    try:
        return int(torch.cuda.get_device_properties(0).total_memory // (1024 * 1024))
    except Exception:
        return 0


def gpu_vram_free_mb() -> int:
    if not torch.cuda.is_available():
        return 0
    try:
        free_bytes, _total_bytes = torch.cuda.mem_get_info(0)
        return int(free_bytes // (1024 * 1024))
    except Exception:
        return 0


def get_pipeline() -> WanPipeline:
    global _pipeline
    if _pipeline is None:
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA GPU not detected. Wan worker requires an NVIDIA CUDA GPU.")
        # Load lazily so health checks do not download multi-GB model weights.
        _pipeline = WanPipeline.from_pretrained(
            MODEL_ID,
            torch_dtype=torch.bfloat16,
        )
        _pipeline.enable_model_cpu_offload()
    return _pipeline


def update_job(job_id: str, **changes: Any) -> dict[str, Any] | None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job or job.get("status") == "deleting":
            return None
        if job.get("status") == "cancelled":
            return dict(job)
        if job.get("status") == "cancel_requested" and changes.get("status") in {"running", "succeeded", "failed"}:
            return dict(job)
        job.update(changes)
        _JOB_STORE.save(dict(job))
        return dict(job)


def is_cancel_requested(job_id: str) -> bool:
    with _jobs_lock:
        job = _jobs.get(job_id)
        return bool(job and job.get("status") in {"cancel_requested", "cancelled", "deleting"})


def finish_cancelled_job(job_id: str, output_path: Path) -> None:
    output_path.unlink(missing_ok=True)
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return
        if job.get("status") == "deleting":
            _jobs.pop(job_id, None)
            _JOB_STORE.delete(job_id)
            return
        if job.get("status") in {"cancel_requested", "cancelled"}:
            now = datetime.now(timezone.utc).isoformat()
            job.update({
                "status": "cancelled",
                "finished_at": job.get("finished_at") or now,
                "cancelled_at": job.get("cancelled_at") or now,
                "cancel_reason": job.get("cancel_reason") or "Wan-Auftrag kontrolliert abgebrochen.",
            })
            _JOB_STORE.save(dict(job))


def cleanup_deleting_job(job_id: str, output_path: Path) -> None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job and job.get("status") == "deleting":
            _jobs.pop(job_id, None)
            _JOB_STORE.delete(job_id)
    output_path.unlink(missing_ok=True)


def safe_job_output_path(job: dict[str, Any]) -> Path | None:
    filename = job.get("filename")
    if not isinstance(filename, str) or not filename:
        return None
    candidate = (OUTPUT_DIR / filename).resolve()
    return candidate if candidate.parent == OUTPUT_DIR else None


def run_generation(job_id: str, prompt: str, aspect_ratio: str, seed: int | None) -> None:
    output_path = OUTPUT_DIR / f"{job_id}.mp4"
    try:
        started = update_job(job_id, status="running", started_at=datetime.now(timezone.utc).isoformat())
        if started is None:
            cleanup_deleting_job(job_id, output_path)
            return
        if started.get("status") in {"cancel_requested", "cancelled"}:
            finish_cancelled_job(job_id, output_path)
            return
        width, height = (832, 480) if aspect_ratio == "16:9" else (480, 832)
        generator = torch.Generator(device="cuda").manual_seed(seed) if seed is not None else None
        with _generation_lock, torch.inference_mode():
            if is_cancel_requested(job_id):
                finish_cancelled_job(job_id, output_path)
                return
            pipe = get_pipeline()
            if is_cancel_requested(job_id):
                finish_cancelled_job(job_id, output_path)
                return
            result = pipe(
                prompt=prompt,
                negative_prompt="low quality, blurry, distorted, watermark, text",
                width=width,
                height=height,
                num_frames=81,
                num_inference_steps=30,
                guidance_scale=5.0,
                generator=generator,
            )
            if is_cancel_requested(job_id):
                finish_cancelled_job(job_id, output_path)
                return
            frames = result.frames[0]
            export_to_video(frames, str(output_path), fps=16)
        if is_cancel_requested(job_id):
            finish_cancelled_job(job_id, output_path)
            return
        if not output_path.is_file() or output_path.stat().st_size < 1024:
            raise RuntimeError("Wan returned no usable MP4 output")
        if output_path.stat().st_size > 100 * 1024 * 1024:
            raise RuntimeError("Wan MP4 exceeds the 100 MB project archive limit")
        updated = update_job(
            job_id,
            status="succeeded",
            finished_at=datetime.now(timezone.utc).isoformat(),
            filename=output_path.name,
            size_bytes=output_path.stat().st_size,
            duration_sec=5,
        )
        if updated is None:
            cleanup_deleting_job(job_id, output_path)
        elif updated.get("status") in {"cancel_requested", "cancelled"}:
            finish_cancelled_job(job_id, output_path)
    except Exception as exc:  # Report failure; never fall back to a paid API.
        if is_cancel_requested(job_id):
            finish_cancelled_job(job_id, output_path)
            return
        output_path.unlink(missing_ok=True)
        if update_job(
            job_id,
            status="failed",
            finished_at=datetime.now(timezone.utc).isoformat(),
            error=str(exc)[:500],
        ) is None:
            cleanup_deleting_job(job_id, output_path)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "engine": "Wan 2.1",
        "model": MODEL_ID,
        "model_loaded": _pipeline is not None,
        "cuda_available": torch.cuda.is_available(),
        "gpu_vram_total_mb": gpu_vram_total_mb(),
        "gpu_vram_free_mb": gpu_vram_free_mb(),
        "max_shot_duration_sec": 5,
        "max_final_duration_sec": 60,
        "cost_fallback": False,
        "cost_gate_open": WAN_GPU_ENABLED and WAN_GPU_COSTS_CONFIRMED and WAN_DAILY_JOB_LIMIT > 0,
        "daily_job_limit": WAN_DAILY_JOB_LIMIT,
        "daily_jobs_remaining": max(0, WAN_DAILY_JOB_LIMIT - _JOB_STORE.daily_usage()),
        "max_concurrent_jobs": WAN_MAX_CONCURRENT_JOBS,
        "job_store": "sqlite",
        "persistent_storage_configured": PERSISTENT_MOUNT_CONFIGURED,
        "model_cache_persistent": MODEL_CACHE_PERSISTENT,
    }


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    return {
        key: job[key]
        for key in (
            "id", "status", "created_at", "started_at", "finished_at", "cancel_requested_at", "cancelled_at",
            "duration_sec", "engine", "filename", "size_bytes", "error", "cancel_reason",
            "project_id", "scene_id",
        )
        if key in job
    }


def request_fingerprint(request: GenerateRequest) -> str:
    payload = request.model_dump() if hasattr(request, "model_dump") else request.dict()
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@app.get("/jobs")
def list_jobs(
    authorization: str | None = Header(default=None),
    principal_hash: str | None = Header(default=None, alias="X-Zero-Principal-Hash"),
    project_id: str | None = Query(default=None, max_length=128),
) -> dict[str, Any]:
    require_auth(authorization)
    if not principal_hash or len(principal_hash) != 64 or any(c not in "0123456789abcdef" for c in principal_hash.lower()):
        raise HTTPException(status_code=401, detail="Authenticated principal is required")
    jobs = _JOB_STORE.list_by_principal(principal_hash.lower(), project_id=project_id, limit=50)
    return {"jobs": [public_job(job) for job in jobs]}


@app.delete("/jobs")
def delete_project_jobs(
    authorization: str | None = Header(default=None),
    principal_hash: str | None = Header(default=None, alias="X-Zero-Principal-Hash"),
    project_id: str = Query(min_length=1, max_length=128),
) -> dict[str, int]:
    require_auth(authorization)
    if not principal_hash or len(principal_hash) != 64 or any(c not in "0123456789abcdef" for c in principal_hash.lower()):
        raise HTTPException(status_code=401, detail="Authenticated principal is required")
    removed = 0
    pending = 0
    with _jobs_lock:
        jobs = _JOB_STORE.mark_project_jobs_for_deletion(principal_hash.lower(), project_id)
        for job in jobs:
            job_id = str(job.get("id", ""))
            if job.get("status") == "deleting":
                _jobs[job_id] = job
                pending += 1
                continue
            _jobs.pop(job_id, None)
            output_path = safe_job_output_path(job)
            if output_path:
                output_path.unlink(missing_ok=True)
            removed += 1
    return {"deleted": removed, "pending": pending}


@app.post("/jobs")
def create_job(
    request: GenerateRequest,
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(default=None),
    principal_hash: str | None = Header(default=None, alias="X-Zero-Principal-Hash"),
    idempotency_key_hash: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    require_auth(authorization)
    require_cost_gate()
    try:
        require_persistent_storage(PERSISTENT_MOUNT_CONFIGURED and MODEL_CACHE_PERSISTENT)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if not torch.cuda.is_available():
        raise HTTPException(status_code=503, detail="CUDA GPU unavailable")
    if not has_sufficient_gpu_memory(gpu_vram_total_mb()):
        raise HTTPException(status_code=503, detail=f"Wan GPU requires at least {12 * 1024} MB VRAM.")
    if not principal_hash or len(principal_hash) != 64 or any(c not in "0123456789abcdef" for c in principal_hash.lower()):
        raise HTTPException(status_code=401, detail="Authenticated principal is required")
    if not idempotency_key_hash or len(idempotency_key_hash) != 64 or any(c not in "0123456789abcdef" for c in idempotency_key_hash.lower()):
        raise HTTPException(status_code=400, detail="A hashed idempotency key is required")

    job_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    fingerprint = request_fingerprint(request)
    job = {
        "id": job_id,
        "status": "queued",
        "created_at": now,
        "duration_sec": 5,
        "engine": "Wan 2.1",
        "project_id": request.project_id,
        "scene_id": request.scene_id,
        "principal_hash": principal_hash.lower(),
        "idempotency_key_hash": idempotency_key_hash.lower(),
        "request_fingerprint": fingerprint,
    }
    with _jobs_lock:
        if len(_jobs) >= 50:
            for old in _JOB_STORE.prune_completed(max_jobs=50, retain_jobs=40):
                old_id = str(old["id"])
                _jobs.pop(old_id, None)
                old_file = OUTPUT_DIR / str(old.get("filename", ""))
                if old_file.parent == OUTPUT_DIR and old_file.is_file():
                    old_file.unlink(missing_ok=True)
            if len(_jobs) >= 50:
                raise HTTPException(status_code=429, detail="Worker job queue is full")
        existing, replayed, conflict, quota_reason, quota_count = _JOB_STORE.create_or_get_limited(
            job,
            daily_limit=WAN_DAILY_JOB_LIMIT,
            max_concurrent=WAN_MAX_CONCURRENT_JOBS,
        )
        if conflict:
            raise HTTPException(status_code=409, detail="Idempotency key was already used for a different Wan request")
        if replayed:
            _jobs[str(existing["id"])] = existing
            return JSONResponse(status_code=200, content={"job": public_job(existing), "replayed": True})
        if quota_reason == "concurrency_limit":
            raise HTTPException(status_code=429, detail="Wan GPU concurrency limit reached")
        if quota_reason == "daily_limit":
            raise HTTPException(status_code=429, detail="Wan daily job limit reached")
        if quota_reason or existing is None:
            raise HTTPException(status_code=503, detail="Wan worker could not reserve the job")
        _jobs[job_id] = job
    background_tasks.add_task(
        asyncio.to_thread,
        run_generation,
        job_id,
        request.prompt.strip(),
        request.aspect_ratio,
        request.seed,
    )
    return JSONResponse(status_code=202, content={"job": public_job(job), "replayed": False})


@app.post("/jobs/{job_id}/cancel")
def cancel_job(
    job_id: str,
    authorization: str | None = Header(default=None),
    principal_hash: str | None = Header(default=None, alias="X-Zero-Principal-Hash"),
) -> dict[str, Any]:
    require_auth(authorization)
    if not principal_hash or len(principal_hash) != 64 or any(c not in "0123456789abcdef" for c in principal_hash.lower()):
        raise HTTPException(status_code=401, detail="Authenticated principal is required")
    try:
        uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Job not found")
    job = _JOB_STORE.request_cancel(job_id, principal_hash.lower())
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    with _jobs_lock:
        _jobs[job_id] = dict(job)
    status = job.get("status")
    return {
        **public_job(job),
        "cancelled": status == "cancelled",
        "cancel_requested": status == "cancel_requested",
        "message": "Abbruch angefordert." if status == "cancel_requested" else "Auftragsstatus aktualisiert.",
    }


@app.get("/jobs/{job_id}")
def get_job(
    job_id: str,
    authorization: str | None = Header(default=None),
    principal_hash: str | None = Header(default=None, alias="X-Zero-Principal-Hash"),
) -> dict[str, Any]:
    require_auth(authorization)
    if not principal_hash or len(principal_hash) != 64 or any(c not in "0123456789abcdef" for c in principal_hash.lower()):
        raise HTTPException(status_code=401, detail="Authenticated principal is required")
    try:
        uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Job not found")
    with _jobs_lock:
        job = dict(_jobs.get(job_id, {}))
    if not job or job.get("status") == "deleting" or not hmac.compare_digest(str(job.get("principal_hash", "")), principal_hash):
        raise HTTPException(status_code=404, detail="Job not found")
    return public_job(job)


@app.get("/jobs/{job_id}/video")
def get_video(
    job_id: str,
    authorization: str | None = Header(default=None),
    principal_hash: str | None = Header(default=None, alias="X-Zero-Principal-Hash"),
) -> FileResponse:
    require_auth(authorization)
    if not principal_hash or len(principal_hash) != 64 or any(c not in "0123456789abcdef" for c in principal_hash.lower()):
        raise HTTPException(status_code=401, detail="Authenticated principal is required")
    try:
        uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Job not found")
    with _jobs_lock:
        job = dict(_jobs.get(job_id, {}))
    if not job or job.get("status") == "deleting" or not hmac.compare_digest(str(job.get("principal_hash", "")), principal_hash):
        raise HTTPException(status_code=404, detail="Job not found")
    if job.get("status") != "succeeded":
        raise HTTPException(status_code=409, detail="Video is not ready")
    video_path = (OUTPUT_DIR / str(job.get("filename", ""))).resolve()
    if video_path.parent != OUTPUT_DIR or not video_path.is_file():
        raise HTTPException(status_code=404, detail="Video file not found")
    return FileResponse(video_path, media_type="video/mp4", filename=f"zero-{job_id}.mp4")
