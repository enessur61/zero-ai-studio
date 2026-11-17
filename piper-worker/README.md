# ZERO German Piper TTS worker

CPU-only German WAV voiceovers via Piper ONNX and the `de_DE-thorsten-medium` voice. The code is MIT; the voice is MIT-licensed. Model files are downloaded on first use and integrity-checked against their published hashes. No Gemini key, GPU, paid speech API or paid fallback is used.

## Render Free deployment

Create a Docker web service from this repository:
- Docker context: `piper-worker`
- Dockerfile: `piper-worker/Dockerfile`
- Plan: Free; Region: Frankfurt
- Secret: `ZERO_TTS_WORKER_TOKEN` (long random value)

Set the same token on ZERO's main Render service as `ZERO_TTS_WORKER_TOKEN` and set `ZERO_TTS_WORKER_URL` to the Piper service's HTTPS URL. The token stays server-side.

Free instances sleep when idle and have ephemeral filesystems. The ~63-MB voice is downloaded and cached on first synthesis and may be downloaded again after restart. Cold-start synthesis can take longer.

## API
- `GET /health` public status without downloading the model.
- `POST /tts` authenticated JSON `{"text":"Guten Morgen","speed":0.96}`; response is a WAV file.
- Max 5,000 characters; speed 0.75–1.25.
