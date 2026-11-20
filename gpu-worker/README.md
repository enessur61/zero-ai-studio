# ZERO Wan 2.1 GPU Worker

Optional self-hosted inference worker for ZERO AI STUDIO. This is a real model runtime, not a mock API. It runs the open-weight Wan 2.1 T2V-1.3B Diffusers checkpoint on an NVIDIA CUDA GPU.

## Important limits

- One request creates one **5-second, 480p shot** (81 frames at 16 fps).
- ZERO's final assembled video must remain at or below **60 seconds**.
- The worker has no hosted inference provider and no paid fallback.
- The model weights are downloaded from Hugging Face on first generation. They are not included in this repository or Docker image.
- An NVIDIA CUDA GPU is mandatory. For this Diffusers pipeline, plan for roughly 11 GB VRAM as a starting point; actual memory depends on driver, precision, offload behavior, and runtime versions. CUDA availability alone does not guarantee enough memory. CPU-only and iPhone execution are not supported.
- The health endpoint does not load/download the model.

## Run with Docker

On a Linux host with an NVIDIA GPU, Docker, and NVIDIA Container Toolkit installed:

1. Create a strong random token and set it as `ZERO_VIDEO_ENGINE_TOKEN`.
2. Build: `docker build -t zero-wan-worker gpu-worker`
3. Create a persistent host directory for worker jobs and outputs.
4. Run with that directory mounted: `docker run --gpus all -p 8000:8000 -v /your/persistent/path/zero-wan-jobs:/data/zero-wan-jobs --env WAN_REQUIRE_PERSISTENT_STORAGE=true --env ZERO_VIDEO_ENGINE_TOKEN='YOUR_TOKEN' zero-wan-worker`
4. Put the worker behind HTTPS before connecting it to a production ZERO instance.

Set these environment variables on the ZERO server:

- `ZERO_VIDEO_ENGINE_URL=https://your-worker.example` (base URL, no path)
- `ZERO_VIDEO_ENGINE_TOKEN=the-same-token`

The worker token must be long and random. Never put it in browser code or the public repository.

## API

All endpoints except `GET /health` require `Authorization: Bearer <token>`.

- `GET /health` — runtime/CUDA status, without loading model weights.
- `POST /jobs` — enqueue a shot. JSON: `{"prompt":"...","duration_sec":5,"aspect_ratio":"16:9","seed":42,"project_id":"...","scene_id":"..."}`. Project/scene IDs are optional recovery metadata. Returns HTTP 202 and a job ID.
- `GET /jobs?limit=50` — list the newest persisted jobs (1–50); reading the list does not mark live GPU work as interrupted.
- `GET /jobs/{id}` — queued/running/cancel_requested/cancelled/succeeded/failed status.
- `POST /jobs/{id}/cancel` — request cancellation. Queued jobs become cancelled immediately; running inference becomes cancel_requested and is finalized only after the current GPU inference step returns. The worker does not claim to interrupt a CUDA kernel mid-step.
- `GET /jobs/{id}/video` — download completed MP4; cancelled jobs never expose a video.

The worker serializes GPU inference, persists job metadata in SQLite, limits job history (including cancelled jobs), validates UUIDs and prompts, and never attempts a paid fallback. With the required persistent volume mounted, completed job records and MP4 files survive worker restarts. Queued/running jobs are marked failed on restart because their GPU execution cannot safely be resumed. A persisted cancel_requested job is finalized as cancelled on restart because the prior worker process is no longer running. Without a persistent mount, the data remains ephemeral; set `WAN_REQUIRE_PERSISTENT_STORAGE=true` in production so startup fails closed when the configured output path is not mounted.

## Hardware and cost

The model is open-weight, but GPU compute, electricity, storage, and network hosting are not inherently free. This repository does not claim a permanently free GPU host. Do not deploy it to a paid service unless you intentionally choose to do so.
