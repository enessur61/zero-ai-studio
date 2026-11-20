#!/usr/bin/env python3
"""Validate the explicitly approved ZERO Preview URL used by native iOS builds."""

from __future__ import annotations

import sys
from urllib.parse import urlsplit

PREVIEW_HOST = "zero-ai-studio-pr115-preview.onrender.com"


def validate_preview_url(value: str, isolation_approved: str) -> str:
    if isolation_approved.strip().lower() != "true":
        raise ValueError(
            "Preview isolation has not been explicitly approved. "
            "Set ZERO_PREVIEW_ISOLATION_APPROVED=true only after manual verification."
        )
    if not value or value != value.strip() or any(character.isspace() for character in value):
        raise ValueError("ZERO_PREVIEW_APP_URL is missing or contains whitespace.")

    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise ValueError("ZERO_PREVIEW_APP_URL is malformed.") from error

    if parsed.scheme != "https":
        raise ValueError("ZERO_PREVIEW_APP_URL must use HTTPS.")
    if (parsed.hostname or "").lower() != PREVIEW_HOST:
        raise ValueError(f"ZERO_PREVIEW_APP_URL must use the approved Preview host {PREVIEW_HOST}.")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("ZERO_PREVIEW_APP_URL must not contain credentials.")
    if port not in (None, 443):
        raise ValueError("ZERO_PREVIEW_APP_URL must not use a non-standard port.")
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment or "?" in value or "#" in value:
        raise ValueError("ZERO_PREVIEW_APP_URL must be the Preview origin without path, query, or fragment.")

    return f"https://{PREVIEW_HOST}"


def main() -> int:
    value = sys.argv[1] if len(sys.argv) > 1 else ""
    approval = sys.argv[2] if len(sys.argv) > 2 else ""
    try:
        print(validate_preview_url(value, approval))
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
