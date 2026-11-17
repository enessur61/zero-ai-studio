from __future__ import annotations

import asyncio
import hashlib
import hmac
import io
import os
import shutil
import urllib.request
import uuid
import wave
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

from job_store import PersistentJobStore, has_persistent_mount, require_persistent_storage

import torch
from diffusers import WanPipeline
from diffusers.utils import export_to_video
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
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
_piper_voice: Any | None = None
_piper_lock = Lock()
PIPER_VOICE_DIR = Path(os.environ.get("PIPER_VOICE_DIR", str(OUTPUT_DIR / "voices"))).resolve()
PIPER_MODEL_NAME = "de_DE-thorsten-high"
PIPER_MODEL_PATH = PIPER_VOICE_DIR / f"{PIPER_MODEL_NAME}.onnx"
PIPER_CONFIG_PATH = PIPER_VOICE_DIR / f"{PIPER_MODEL_NAME}.onnx.json"
PIPER_MODEL_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/high/de_DE-thorsten-high.onnx"
PIPER_CONFIG_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/high/de_DE-thorsten-high.onnx.json"
PIPER_MODEL_MD5 = "256505fe58fb8b9d6ed78b83f6a9d2"
PIPER_CONFIG_MD5 = "e81686e00a9d825e2488ead660bec6fd"


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=8, max_length=1800)
    # One Wan shot is deliberately capped at 5 seconds. ZERO assembles shots
    # into a final timeline that is independently hard-capped at 60 seconds.
    duration_sec: int = Field(default=5, ge=5, le=5)
    aspect_ratio: str = Field(default="16:9", pattern="^(16:9|9:16)$")
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1)


class PiperTTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    speed: float = Field(default=1.0, ge=0.75, le=1.25)


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


def _file_md5(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _download_piper_file(url: str, path: Path, expected_md5: str, max_bytes: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file() and path.stat().st_size <= max_bytes and _file_md5(path) == expected_md5:
        return
    path.unlink(missing_ok=True)
    temporary = path.with_suffix(path.suffix + ".part")
    digest = hashlib.md5()
    total = 0
    request = urllib.request.Request(url, headers={"User-Agent": "ZERO-AI-STUDIO/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=45) as response, temporary.open("wb") as target:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise RuntimeError("Piper voice download exceeded its size limit")
                digest.update(chunk)
                target.write(chunk)
        if digest.hexdigest() != expected_md5:
            raise RuntimeError("Piper voice download failed its published integrity check")
        temporary.replace(path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def get_piper_voice() -> Any:
    global _piper_voice
    with _piper_lock:
        if _piper_voice is not None:
            return _piper_voice
        _download_piper_file(PIPER_MODEL_URL, PIPER_MODEL_PATH, PIPER_MODEL_MD5, 130 * 1024 * 1024)
        _download_piper_file(PIPER_CONFIG_URL, PIPER_CONFIG_PATH, PIPER_CONFIG_MD5, 1 * 1024 * 1024)
        try:
            from piper import PiperVoice
        except ImportError as exc:
            raise RuntimeError("Piper TTS ist im Worker nicht installiert") from exc
        _piper_voice = PiperVoice.load(str(PIPER_MODEL_PATH))
        return _piper_voice


def synthesize_piper_wav(text: str, speed: float = 1.0) -> bytes:
    from piper import SynthesisConfig

    voice = get_piper_voice()
    buffer = io.BytesIO()
    config = SynthesisConfig(
        volume=1.0,
        length_scale=1.0 / speed,
        noise_scale=0.667,
        noise_w_scale=0.8,
        normalize_audio=True,
    )
    # Piper returns a real RIFF/WAVE file at the voice's native 22.05 kHz rate.
    with wave.open(buffer, "wb") as wav_file:
        voice.synthesize_wav(text, wav_file, syn_config=config)
    audio = buffer.getvalue()
    if len(audio) < 44 or not audio.startswith(b"RIFF") or audio[8:12] != b"WAVE":
        raise RuntimeError("Piper did not return a valid WAV file")
    return audio


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
        "tts_engine": "Piper ONNX",
        "tts_voice": PIPER_MODEL_NAME,
        "tts_voice_downloaded": PIPER_MODEL_PATH.is_file() and PIPER_CONFIG_PATH.is_file(),
        "tts_available": True,
        "cost_fallback": False,
    }


@app.post("/tts")
def create_tts(
    request: PiperTTSRequest,
    authorization: str | None = Header(default=None),
) -> StreamingResponse:
    require_auth(authorization)
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text für die Sprachausgabe fehlt")
    try:
        audio = synthesize_piper_wav(text, request.speed)
    except Exception as exc:
        # No external speech service or paid fallback is ever called.
        raise HTTPException(status_code=503, detail=f"Piper TTS ist nicht verfügbar: {str(exc)[:240]}") from exc
    return StreamingResponse(
        iter([audio]),
        media_type="audio/wav",
        headers={
            "Content-Length": str(len(audio)),
            "Content-Disposition": 'attachment; filename="zero-piper-de.wav"',
            "X-Zero-TTS-Model": PIPER_MODEL_NAME,
            "X-Zero-TTS-Cost": "0",
        },
    )


@app.post("/jobs", status_code=202)
def create_job(
    request: GenerateRequest,
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    require_auth(authorization)
    try:
        require_persistent_storage(PERSISTENT_MOUNT_CONFIGURED)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
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
