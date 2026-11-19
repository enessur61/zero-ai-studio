# ZERO German Piper TTS worker

CPU-only German WAV voiceovers via Piper ONNX and the `de_DE-thorsten-medium` voice. The container explicitly requires ONNX Runtime's `CPUExecutionProvider`; CUDA and an NVIDIA GPU are not required. The Debian Bookworm image is built for `linux/amd64` and `linux/arm64` when pinned wheels are available. Voice files are downloaded on first use, checked against exact byte sizes, published MD5 digests and the model's LFS SHA-256, then stored under `/var/lib/zero-piper` (mount this path persistently). The engine is pinned to `piper-tts==1.8.0` (the voice card requires Piper 1.5+). No Gemini key, GPU, paid speech API or paid fallback is used.

## Pinned Thorsten voice

- Repository revision: `cf910fb59f1d79ab3b625a63993a108751c6c25d` (immutable commit; no floating `main` URL).
- Voice: `de_DE-thorsten-medium`, German (Germany), medium quality, one speaker, 22,050 Hz.
- Model: 63,221,984 bytes; MD5 `e2fe077168bfe802e951e717dfa85873`; Git LFS SHA-256 `fd270eb3d1ebf91d763f8a0f949b1b1bebdfefaea18c3aaf8577dd34536e064f`.
- Config: 6,455 bytes; MD5 `dac4f7530c978753aeb40f214245659f`.
- Model card: 427 bytes; MD5 `77302e0f4569b902d16e49db4a43492d`.
- Model-card inference defaults: `noise_scale=0.5`, `noise_w=0.333`; ZERO uses those values.
- The previous Thorsten revision derived from the U.S. English Lessac voice is explicitly excluded. Do not fall back to it or to a floating branch/tag.
- The model card identifies the German Thorsten-Voice dataset as CC0 and the rdh base as CC0; this is provenance metadata, not a legal guarantee for every downstream use.

## Self-hosted ARM64 deployment

Build with Docker context `piper-worker` and this Dockerfile. The default model directory is `/var/lib/zero-piper`; `docker-compose.workers.yml` mounts a named volume there. Create `.env.workers` from `workers.env.example` and set a long random `ZERO_TTS_WORKER_TOKEN`. Keep the SearXNG secret in the separate `searxng/searxng.env` file copied from `searxng/searxng.env.example`. The worker is published only on `127.0.0.1:8000`. The voice is downloaded on first synthesis, so first use needs outbound HTTPS access to the pinned model files. The ARM64 CI smoke test does not download voice weights or call inference providers.

## API
- `GET /health` public status without downloading the model.
- `POST /tts` authenticated JSON `{"text":"Guten Morgen","speed":0.96}`; response is a WAV file.
- Max 5,000 characters; speed 0.75–1.25.
