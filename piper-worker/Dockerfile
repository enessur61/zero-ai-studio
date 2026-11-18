FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIPER_MODEL_DIR=/tmp/zero-piper
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libespeak-ng1 libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py voice_assets.py .
COPY voice/MODEL_CARD.md ./voice/MODEL_CARD.md
EXPOSE 8000
CMD ["uvicorn","app:app","--host","0.0.0.0","--port","8000","--workers","1"]
