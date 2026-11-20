FROM python:3.11-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIPER_MODEL_DIR=/var/lib/zero-piper
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends libespeak-ng1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/zero-piper \
    && chown -R 10001:10001 /var/lib/zero-piper /app
COPY requirements.txt .
RUN pip install --no-cache-dir --requirement requirements.txt \
    && python -c "import onnxruntime as ort; from piper import PiperVoice; assert 'CPUExecutionProvider' in ort.get_available_providers(); print('Piper CPU runtime:', ort.get_available_providers())"
COPY --chown=10001:10001 app.py voice_assets.py .
COPY --chown=10001:10001 voice/MODEL_CARD.md ./voice/MODEL_CARD.md
USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
