# ZERO Wan 2.1 GPU Worker

Optional self-hosted inference worker for ZERO AI STUDIO. This is a real model runtime, not a mock API. It runs the open-weight Wan 2.1 T2V-1.3B Diffusers checkpoint on an NVIDIA CUDA GPU.

## Important limits

- One request creates one **5-second, 480p shot** (81 frames at 16 fps).
- One autonomous episode can use at most three Wan shots; the other scenes use the local storyboard compositor.
- The worker's conservative default is **3 jobs/day**. An operator may configure up to **15 jobs/day** (ZERO_WAN_GPU_DAILY_JOB_LIMIT=15), enough for three shots in each of five episodes. Jobs are serialized (one GPU job at a time); this is a ceiling, not a throughput guarantee.
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
- `POST /jobs` — enqueue a shot. JSON: `{"prompt":"...","duration_sec":5,"aspect_ratio":"16:9","seed":42}`. Returns HTTP 202 and a job ID.
- `GET /jobs/{id}` — queued/running/succeeded/failed status.
- `GET /jobs/{id}/video` — download completed MP4.

The worker serializes GPU inference, persists job metadata in SQLite, limits job history, validates UUIDs and prompts, and never attempts a paid fallback. With the required persistent volume mounted, completed job records and MP4 files survive worker restarts. Queued/running jobs are marked failed on restart because their GPU execution cannot safely be resumed. Without a persistent mount, the data remains ephemeral; set `WAN_REQUIRE_PERSISTENT_STORAGE=true` in production so startup fails closed when the configured output path is not mounted.

## ZERO project clip archive

When a completed Wan clip is recovered in ZERO Video Studio, the app can copy the binary MP4/WebM into the existing PostgreSQL database as a principal-bound project asset. This is separate from the worker's SQLite job history and persistent GPU volume, so a clip remains available in the project's history even after the worker prunes an old job record.

- Maximum clip size: 100 MiB.
- Maximum archived clips per project: 50.
- Maximum total archived video per project: 500 MiB.
- Retention: archived project clips remain until the user explicitly deletes them or deletes the owning project.
- No time-based auto-deletion is applied to archived project clips; hard per-project count and byte quotas prevent unbounded growth.
- Users can explicitly download or delete individual clips; deleting a project removes its archived clips.
- PostgreSQL must be configured for durable production use. If the database is unavailable, ZERO may keep a local IndexedDB cache, but it must not report that the clip is durably archived.

The archive uses the existing ZERO PostgreSQL connection; it does not introduce a new paid storage provider. Database capacity and hosting costs still depend on the existing deployment plan.

## Hardware and cost

The upstream model card reports about four minutes for one 5-second 480p T2V-1.3B clip on an RTX 4090; actual ZERO throughput must be benchmarked on the deployed host. At that reference speed, 15 shots take roughly one hour of inference before startup, polling, voice, and final rendering. This is a planning estimate, not a measured ZERO result.

The model is open-weight, but GPU compute, electricity, storage, and network hosting are not inherently free. This repository does not claim a permanently free GPU host. Do not deploy it to a paid service unless you intentionally choose to do so.
