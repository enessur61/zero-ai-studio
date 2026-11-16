# Build on a machine with an NVIDIA GPU and NVIDIA Container Toolkit.
FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime

WORKDIR /opt/zero-wan-worker
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py job_store.py .
ENV PYTHONUNBUFFERED=1
ENV WAN_OUTPUT_DIR=/data/zero-wan-jobs
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
