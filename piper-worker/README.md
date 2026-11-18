# ZERO German Piper TTS worker

CPU-only German WAV voiceovers through Piper ONNX using the pinned de_DE-thorsten-medium checkpoint.

## Licensing and provenance — engine and voice are separate

- **Piper engine:** `piper-tts==1.8.0`, GPL-3.0-or-later.
- **Voice:** pinned upstream revision `cf910fb59f1d79ab3b625a63993a108751c6c25d`.
- **Training provenance:** the upstream Thorsten model card identifies the Thorsten-Voice dataset as CC0 and the `rdh` base (one Flemish speaker, nl_BE) as CC0. The old Lessac-derived checkpoint is no longer used.
- **Compatibility:** the pinned model card requires Piper 1.5 or higher. ZERO pins Piper 1.8.0.
- **Integrity:** ONNX file SHA-256 and exact size are checked before loading. The JSON config is parsed and checked against the pinned language, sample rate, Piper metadata and inference defaults. The pinned upstream model card is bundled at `voice/MODEL_CARD.md`.

The model card's provenance is recorded faithfully; ZERO does not make a blanket legal determination or mark commercial use as legally cleared. Keep the engine license and exact voice model card with redistributed artifacts. This README is not legal advice.

## Default-deny cost gate

ZERO will not contact this worker unless both operator-controlled flags are explicitly set:

```env
ZERO_PIPER_WORKER_ENABLED=false
ZERO_PIPER_WORKER_COSTS_CONFIRMED=false
ZERO_TTS_WORKER_URL=
ZERO_TTS_WORKER_TOKEN=
```

Set the two flags to true only after independently confirming the hosting plan and its billing terms. The flags are an operator confirmation, not an automatic billing guarantee. ZERO never switches to a paid TTS provider if the worker is disabled, asleep, unavailable, or fails.

## Optional self-hosted deployment

Create a Docker web service from this repository:
- Docker context: piper-worker
- Dockerfile: piper-worker/Dockerfile
- Configure a long random ZERO_TTS_WORKER_TOKEN on the worker and the same secret on ZERO.
- Set ZERO_TTS_WORKER_URL on ZERO to the worker's HTTPS URL.

Do not assume a free hosting plan is permanent or guaranteed. Free instances may sleep while idle and have ephemeral filesystems. The ~63-MB voice may be downloaded again after restart; cold-start synthesis can take longer. The worker verifies the pinned ONNX SHA-256 and rejects incompatible or modified voice configuration files. A paid hosting plan or usage charge must never be enabled implicitly.

## API

- GET /health is public and returns engine, exact model revision, voice, file-presence and loaded-state diagnostics without downloading weights.
- POST /tts accepts authenticated JSON with text and speed and returns a WAV file.
- Max 5,000 characters; speed 0.75–1.25; maximum WAV size 20 MB.
