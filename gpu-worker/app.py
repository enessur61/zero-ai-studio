from __future__ import annotations

import asyncio
import hmac
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

from job_store import PersistentJobStore

import torch
from diffusers import WanPipeline
from diffusers.utils import export_to_video
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

APP_TOKEN = os.environ.get("ZERO_VIDEO_ENGINE_TOKEN", "")
MODEL_ID = os.environ.get("WAN_MODEL_ID", "Wan-AI/Wan2.1-T2V-1.3B-Diffusers")
OUTPUT_DIR = Path(os.environ.get("WAN_OUTPUT_DIR", "/tmp/zero-wan-jobs")).resolve()
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def has_persistent_mount(path: Path) -> bool:
    current = path
    while current != current.parent:
        if current != Path('/') and current.is_mount():
            return True
        current = current.parent
    return False


PERSISTENT_MOUNT_CONFIGURED = has_persistent_mount(OUTPUT_DIR)
if os.environ.get("WAN_REQUIRE_PERSISTENT_STORAGE", "false").lower() == "true" and not PERSISTENT_MOUNT_CONFIGURED:
    raise RuntimeError("WAN_REQUIRE_PERSISTENT_STORAGE=true but WAN_OUTPUT_DIR is not on a mounted persistent volume")

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


def update_job(job_id: str, **changes: Any) -> dict[str, Any]:
    with _jobs_lock:
        job = _jobs[job_id]
        job.update(changes)
        _JOB_STORE.save(dict(job))
        return dict(job)


def run_generation(job_id: str, prompt: str, aspect_ratio: str, seed: int | None) -> None:
    output_path = OUTPUT_DIR / f"{job_id}.mp4"
    try:
        update_job(job_id, status="running", started_at=datetime.now(timezone.utc).isoformat())
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
        update_job(
            job_id,
            status="succeeded",
            finished_at=datetime.now(timezone.utc).isoformat(),
            filename=output_path.name,
            size_bytes=output_path.stat().st_size,
            duration_sec=5,
        )
    except Exception as exc:  # Report failure; never fall back to a paid API.
        update_job(
            job_id,
            status="failed",
            finished_at=datetime.now(timezone.utc).isoformat(),
            error=str(exc)[:500],
        )


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


@app.post("/jobs", status_code=202)
def create_job(
    request: GenerateRequest,
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    require_auth(authorization)
    if not torch.cuda.is_available():
        raise HTTPException(status_code=503, detail="CUDA GPU unavailable")
    job_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    with _jobs_lock:
        # Keep only a small in-memory history; do not let an unauthenticated
        # caller or long-running host grow the job registry without bound.
        if len(_jobs) >= 50:
            for old in _JOB_STORE.prune_completed(max_jobs=50, retain_jobs=40):
                old_id = str(old["id"])
                _jobs.pop(old_id, None)
                old_file = OUTPUT_DIR / str(old.get("filename", ""))
                if old_file.parent == OUTPUT_DIR and old_file.is_file():
                    old_file.unlink(missing_ok=True)
            if len(_jobs) >= 50:
                raise HTTPException(status_code=429, detail="Worker job queue is full")
        _jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "created_at": now,
            "duration_sec": 5,
            "engine": "Wan 2.1",
        }
        _JOB_STORE.save(dict(_jobs[job_id]))
    background_tasks.add_task(
        asyncio.to_thread,
        run_generation,
        job_id,
        request.prompt.strip(),
        request.aspect_ratio,
        request.seed,
    )
    return {"id": job_id, "status": "queued", "duration_sec": 5, "engine": "Wan 2.1"}


@app.get("/jobs/{job_id}")
def get_job(job_id: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_auth(authorization)
    try:
        uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Job not found")
    with _jobs_lock:
        job = dict(_jobs.get(job_id, {}))
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/jobs/{job_id}/video")
def get_video(job_id: str, authorization: str | None = Header(default=None)) -> FileResponse:
    require_auth(authorization)
    try:
        uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Job not found")
    with _jobs_lock:
        job = dict(_jobs.get(job_id, {}))
    if not job or job.get("status") != "succeeded":
        raise HTTPException(status_code=409, detail="Video is not ready")
    video_path = OUTPUT_DIR / str(job.get("filename", ""))
    if video_path.parent != OUTPUT_DIR or not video_path.is_file():
        raise HTTPException(status_code=404, detail="Video file not found")
    return FileResponse(video_path, media_type="video/mp4", filename=f"zero-{job_id}.mp4")
