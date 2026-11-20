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

from job_store import PersistentJobStore, has_persistent_mount, require_persistent_storage

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


PERSISTENT_MOUNT_CONFIGURED = has_persistent_mount(OUTPUT_DIR)
if os.environ.get("WAN_REQUIRE_PERSISTENT_STORAGE", "false").lower() == "true":
    require_persistent_storage(PERSISTENT_MOUNT_CONFIGURED)

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
        job.update(changes)
        _JOB_STORE.save(dict(job))
        return dict(job)


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
        if update_job(job_id, status="running", started_at=datetime.now(timezone.utc).isoformat()) is None:
            cleanup_deleting_job(job_id, output_path)
            return
        # Wan T2V-1.3B generates one short 480p shot (81 frames / about 5s).
        width, height = (832, 480) if aspect_ratio == "16:9" else (480, 832)
        generator = torch.Generator(device="cuda").manual_seed(seed) if seed is not None else None
        with _generation_lock, torch.inference_mode():
            pipe = get_pipeline()
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
            frames = result.frames[0]
            export_to_video(frames, str(output_path), fps=16)
        if not output_path.is_file() or output_path.stat().st_size < 1024:
            raise RuntimeError("Wan returned no usable MP4 output")
        if update_job(
            job_id,
            status="succeeded",
            finished_at=datetime.now(timezone.utc).isoformat(),
            filename=output_path.name,
            size_bytes=output_path.stat().st_size,
            duration_sec=5,
        ) is None:
            cleanup_deleting_job(job_id, output_path)
    except Exception as exc:  # Report failure; never fall back to a paid API.
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
        "max_shot_duration_sec": 5,
        "max_final_duration_sec": 60,
        "cost_fallback": False,
        "job_store": "sqlite",
        "persistent_storage_configured": PERSISTENT_MOUNT_CONFIGURED,
    }


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    return {
        key: job[key]
        for key in (
            "id", "status", "created_at", "started_at", "finished_at",
            "duration_sec", "engine", "filename", "size_bytes", "error",
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
    try:
        require_persistent_storage(PERSISTENT_MOUNT_CONFIGURED)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if not torch.cuda.is_available():
        raise HTTPException(status_code=503, detail="CUDA GPU unavailable")
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
        existing, replayed, conflict = _JOB_STORE.create_or_get(job)
        if conflict:
            raise HTTPException(status_code=409, detail="Idempotency key was already used for a different Wan request")
        if replayed:
            _jobs[str(existing["id"])] = existing
            return JSONResponse(status_code=200, content={"job": public_job(existing), "replayed": True})

        if len(_jobs) >= 50:
            for old in _JOB_STORE.prune_completed(max_jobs=50, retain_jobs=40):
                old_id = str(old["id"])
                _jobs.pop(old_id, None)
                old_file = OUTPUT_DIR / str(old.get("filename", ""))
                if old_file.parent == OUTPUT_DIR and old_file.is_file():
                    old_file.unlink(missing_ok=True)
            if len(_jobs) >= 50:
                _JOB_STORE.delete(job_id)
                raise HTTPException(status_code=429, detail="Worker job queue is full")
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


@app.get("/jobs/{job_id}")
def get_job(
    job_id: str,
    authorization: str | None = Header(default=None),
    principal_hash: str | None = Header(default=None, alias="X-Zero-Principal-Hash"),
) -> dict[str, Any]:
    require_auth(authorization)
    if not principal_hash:
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
    if not principal_hash:
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
