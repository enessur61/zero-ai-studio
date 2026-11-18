# ZERO German Piper TTS worker

CPU-only German WAV voiceovers through Piper ONNX using the pinned de_DE-thorsten-medium checkpoint.

## Licensing — engine and voice are separate

- **Piper engine:** GPL-3.0-or-later (piper-tts==1.3.0).
- **Voice dataset:** the Thorsten recordings are marked CC0 in the voice MODEL_CARD.
- **Important checkpoint caveat:** the pinned revision used here is fine-tuned from the U.S. English Lessac medium voice. The CC0 dataset label does not itself grant rights to the Lessac-derived checkpoint. Do not treat this pinned artifact as commercially cleared. For commercial use, first pin and verify a newer rdh-based Thorsten-medium revision and carry its exact MODEL_CARD with the model files.

The engine and voice have different licenses. Keep their notices and the exact voice MODEL_CARD with any redistributed artifacts. This README does not provide legal advice.

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

Do not assume a free hosting plan is permanent or guaranteed. Free instances may sleep while idle and have ephemeral filesystems. The ~63-MB voice may be downloaded again after restart; cold-start synthesis can take longer. A paid hosting plan or usage charge must never be enabled implicitly.

## API

- GET /health is authenticated with the worker bearer token; it returns engine, exact model revision, voice, file-presence and loaded-state diagnostics without downloading weights.
- POST /tts accepts authenticated JSON with text and speed and returns a WAV file.
- Max 5,000 characters; speed 0.75–1.25; maximum WAV size 20 MB.
