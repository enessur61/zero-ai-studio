from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

VOICE_REVISION = "cf910fb59f1d79ab3b625a63993a108751c6c25d"
VOICE_ID = "de_DE-thorsten-medium"
MODEL_SIZE_BYTES = 63_221_984
MODEL_SHA256 = "fd270eb3d1ebf91d763f8a0f949b1b1bebdfefaea18c3aaf8577dd34536e064f"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_model_file(path: Path) -> None:
    if not path.is_file() or path.stat().st_size != MODEL_SIZE_BYTES:
        raise RuntimeError("Piper voice model has an unexpected file size")
    if sha256_file(path) != MODEL_SHA256:
        raise RuntimeError("Piper voice model failed the pinned SHA-256 integrity check")


def validate_voice_config(path: Path) -> dict[str, Any]:
    if not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise RuntimeError("Piper voice config is missing or exceeds the size limit")
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Piper voice config is not valid UTF-8 JSON") from exc

    if not isinstance(config, dict):
        raise RuntimeError("Piper voice config root must be a JSON object")
    audio = config.get("audio", {})
    espeak = config.get("espeak", {})
    inference = config.get("inference", {})
    language = config.get("language", {})
    if not all(isinstance(section, dict) for section in (audio, espeak, inference, language)):
        raise RuntimeError("Piper voice config sections must be JSON objects")
    expected = (
        config.get("phoneme_type") == "espeak"
        and config.get("num_symbols") == 256
        and config.get("num_speakers") == 1
        and config.get("piper_version") == "1.5.0"
        and config.get("default_speaker_id") == 0
        and audio.get("sample_rate") == 22050
        and espeak.get("voice") == "de"
        and language.get("code") == "de_DE"
        and inference.get("noise_scale") == 0.5
        and inference.get("length_scale") == 1.0
        and inference.get("noise_w") == 0.333
        and isinstance(config.get("phoneme_id_map"), dict)
        and bool(config["phoneme_id_map"])
    )
    if not expected:
        raise RuntimeError("Piper voice config does not match the pinned rdh-based Thorsten medium metadata")
    return config
