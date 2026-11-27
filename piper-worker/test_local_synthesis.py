from __future__ import annotations

import io
import os
import sys
import tempfile
import wave
from pathlib import Path
from unittest.mock import patch

# Reuse a caller-provided cache so the verified assets can be mounted read-only
# into the subsequent network-isolated ARM64 inference test. Local ad-hoc runs
# still get an automatically cleaned temporary cache.
cache_dir = os.environ.get("PIPER_MODEL_DIR", "").strip()
temporary_cache = None
if cache_dir:
    Path(cache_dir).mkdir(parents=True, exist_ok=True)
else:
    temporary_cache = tempfile.TemporaryDirectory(prefix="zero-piper-local-synthesis-")
    cache_dir = str(Path(temporary_cache.name) / "voice-cache")
    Path(cache_dir).mkdir(parents=True, exist_ok=True)

os.environ["PIPER_MODEL_DIR"] = cache_dir
sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    import app
    from voice_assets import sha256_file, validate_model_file, validate_voice_config

    first_audio = app.synthesize(
        "ZERO lokaler Piper-Test. Dies ist eine lokale deutsche Sprachsynthese.",
        1.0,
    )
    assert app.voice is not None, "Piper ONNX voice must be loaded by local CPU inference"
    assert app.MODEL.is_file() and app.CONFIG.is_file(), "Pinned voice assets must be persisted in the cache"
    validate_model_file(app.MODEL)
    validate_voice_config(app.CONFIG)

    with wave.open(io.BytesIO(first_audio), "rb") as audio:
        assert audio.getnchannels() == 1, "Piper output must be mono"
        assert audio.getsampwidth() == 2, "Piper output must be 16-bit PCM"
        assert audio.getframerate() == 22050, "Piper output must use the pinned 22.05-kHz sample rate"
        assert audio.getnframes() > 0, "Piper must emit non-empty audio frames"

    # Drop only the in-memory model. The second inference must reload from the
    # verified persistent cache and must not contact the model host again.
    app.voice = None
    with patch(
        "app.urllib.request.urlopen",
        side_effect=AssertionError("verified cache unexpectedly attempted a network download"),
    ):
        second_audio = app.synthesize("ZERO Cache-Wiederverwendung ohne Netzwerk.", 1.0)

    assert app.voice is not None
    with wave.open(io.BytesIO(second_audio), "rb") as audio:
        assert audio.getnframes() > 0
        assert audio.getframerate() == 22050

    print(f"Piper pinned voice config SHA-256: {sha256_file(app.CONFIG)}")
    print(
        "Piper local CPU synthesis passed: pinned model/config verified, "
        "22.05-kHz mono PCM WAV emitted, and second inference reloaded "
        "from the persistent cache without network access."
    )
finally:
    if temporary_cache is not None:
        temporary_cache.cleanup()
