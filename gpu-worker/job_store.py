from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


class PersistentJobStore:
    """SQLite-backed job metadata for a single GPU worker with a persistent volume."""

    def __init__(self, output_dir: str | Path) -> None:
        self.output_dir = Path(output_dir).resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.database_path = self.output_dir / "jobs.sqlite3"
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS zero_video_jobs (
                    id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )

    def save(self, job: dict[str, Any]) -> None:
        payload = json.dumps(job, separators=(",", ":"), ensure_ascii=False)
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO zero_video_jobs (id, payload, updated_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(id) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (str(job["id"]), payload),
            )

    def delete(self, job_id: str) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM zero_video_jobs WHERE id = ?", (job_id,))

    def load_all(self) -> dict[str, dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, payload FROM zero_video_jobs ORDER BY updated_at DESC"
            ).fetchall()

        jobs: dict[str, dict[str, Any]] = {}
        for job_id, payload in rows:
            try:
                job = json.loads(payload)
            except (TypeError, json.JSONDecodeError):
                self.delete(str(job_id))
                continue
            if not isinstance(job, dict) or job.get("id") != job_id:
                self.delete(str(job_id))
                continue

            if job.get("status") in {"queued", "running"}:
                job.update({
                    "status": "failed",
                    "finished_at": job.get("finished_at") or job.get("updated_at") or job.get("created_at"),
                    "error": "GPU-Worker wurde während dieses Auftrags neu gestartet. Auftrag wurde nicht automatisch erneut ausgeführt.",
                })
                self.save(job)
            elif job.get("status") == "succeeded":
                filename = job.get("filename")
                video_path = (self.output_dir / str(filename)).resolve() if filename else None
                if not video_path or video_path.parent != self.output_dir or not video_path.is_file():
                    job.update({
                        "status": "failed",
                        "error": "Gespeichertes MP4 fehlt auf dem persistenten Worker-Speicher.",
                    })
                    self.save(job)

            jobs[str(job_id)] = job
        return jobs

    def prune_completed(self, max_jobs: int = 50, retain_jobs: int = 40) -> list[dict[str, Any]]:
        if max_jobs < 1 or retain_jobs < 1 or retain_jobs >= max_jobs:
            raise ValueError("Invalid job retention limits.")
        jobs = self.load_all()
        if len(jobs) < max_jobs:
            return []
        completed = [
            job for job in jobs.values()
            if job.get("status") in {"succeeded", "failed"}
        ]
        completed.sort(key=lambda job: str(job.get("created_at", "")))
        remove_count = max(0, len(jobs) - retain_jobs)
        removed = completed[:remove_count]
        for job in removed:
            self.delete(str(job["id"]))
        return removed
