# ZERO German Piper TTS worker

Optional CPU-only German WAV voiceovers using Piper ONNX and the pinned `de_DE-thorsten-medium` voice. No Gemini key, NVIDIA GPU, third-party speech API, paid provider fallback, or public worker port is required.

## Engine, voice provenance and integrity

- **Piper engine:** `piper-tts==1.8.0`, GPL-3.0-or-later.
- **Voice:** immutable upstream revision `cf910fb59f1d79ab3b625a63993a108751c6c25d`.
- **Training provenance:** the upstream Thorsten model card identifies the Thorsten-Voice dataset as CC0 and the `rdh` base (one Flemish speaker, nl_BE) as CC0.
- **Compatibility:** the pinned voice model card requires Piper 1.5 or higher; ZERO pins Piper 1.8.0.
- **Integrity:** the ONNX file is checked against exact size, published MD5 and pinned SHA-256. The JSON config is checked structurally against the pinned language, sample rate, model metadata and inference defaults. The upstream model card is bundled at `voice/MODEL_CARD.md`.

The voice model card's provenance is recorded as supplied upstream. ZERO does not make a blanket legal determination or mark commercial use as legally cleared. Keep the engine license and exact voice model card with redistributed artifacts. This README is not legal advice.

## Default-deny cost gate

ZERO will not contact this worker unless both operator-controlled flags are explicitly true:

```env
ZERO_PIPER_WORKER_ENABLED=false
ZERO_PIPER_WORKER_COSTS_CONFIRMED=false
ZERO_TTS_WORKER_URL=
ZERO_TTS_WORKER_TOKEN=
```

Set both flags to true only after independently confirming that the worker is self-hosted on resources you control and that the hosting plan has no unexpected billing. The flags are operator attestations, not an automatic billing guarantee. ZERO never switches to a paid TTS provider if the worker is disabled, sleeping, unavailable, or fails.

## Optional Docker Compose deployment

The repository's `docker-compose.workers.yml` runs the service as `zero-worker` on the private Compose network only. It has no published host port, runs read-only as an unprivileged user, and stores the downloaded voice in the named `piper-voice-cache` volume.

1. Copy `production.env.example` to `production.env` and `workers.env.example` to `.env.workers`.
2. Generate a long random `ZERO_TTS_WORKER_TOKEN`; use the same value in both files.
3. Keep both Piper cost flags false until the hosting-cost review is complete.
4. Start with `docker compose -f docker-compose.workers.yml up -d --build`.
5. Do not expose port 8000 publicly. ZERO reaches the worker internally at `http://zero-worker:8000`.

A local Docker host is not automatically free: verify hardware, electricity, bandwidth and hosting terms yourself. Never enable a paid worker or fallback implicitly.

## API

- `GET /health` is public and reports engine, exact model revision, integrity metadata and loaded state without downloading voice weights.
- `POST /tts` requires the shared bearer token and accepts JSON with `text` and `speed`; it returns WAV audio.
- `GET /search` is authenticated and proxies only to the configured private SearXNG instance.
- Text is limited to 5,000 characters, speed to 0.75–1.25, and WAV output to 20 MB.
