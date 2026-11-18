from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any



WAN_MIN_GPU_VRAM_MB = 12 * 1024


def has_sufficient_gpu_memory(total_bytes: int, minimum_mb: int = WAN_MIN_GPU_VRAM_MB) -> bool:
    """Require a realistic minimum GPU memory budget before accepting inference."""
    return total_bytes >= minimum_mb * 1024 * 1024


_PERSISTENT_FILESYSTEMS = {
    "ext2", "ext3", "ext4", "xfs", "btrfs", "zfs",
    "nfs", "nfs4", "cifs", "ceph", "glusterfs",
}


def has_persistent_mount(path: str | Path, mountinfo_text: str | None = None) -> bool:
    """Return true only when path is backed by a non-ephemeral mounted filesystem.

    Docker's writable container layer (overlay) and memory-backed mounts such
    as tmpfs are deliberately rejected. The longest matching mount point wins,
    so a nested ephemeral mount cannot inherit a persistent parent volume.
    """
    target = Path(path).resolve()
    if mountinfo_text is None:
        try:
            mountinfo_text = Path("/proc/self/mountinfo").read_text(encoding="utf-8")
        except OSError:
            return False

    best_mount: Path | None = None
    best_fs: str | None = None
    for line in mountinfo_text.splitlines():
        before, separator, after = line.partition(" - ")
        if not separator:
            continue
        fields = before.split()
        post_fields = after.split()
        if len(fields) < 5 or not post_fields:
            continue
        mount_text = fields[4]
        for escaped, actual in (("\\040", " "), ("\\011", "\t"), ("\\012", "\n"), ("\\134", "\\")):
            mount_text = mount_text.replace(escaped, actual)
        mount_point = Path(mount_text)
        try:
            target.relative_to(mount_point)
        except ValueError:
            continue
        if best_mount is None or len(str(mount_point)) > len(str(best_mount)):
            best_mount = mount_point
            best_fs = post_fields[0].lower()

    return best_mount is not None and best_fs in _PERSISTENT_FILESYSTEMS


def require_persistent_storage(configured: bool) -> None:
    """Fail closed before accepting jobs when the worker volume is ephemeral."""
    if not configured:
        raise RuntimeError(
            "GPU worker storage is ephemeral. Configure WAN_OUTPUT_DIR and HF_HOME on persistent volumes before accepting jobs."
        )


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

    def daily_usage(self, utc_day: str | None = None) -> int:
        """Return the number of accepted GPU jobs for the current UTC day."""
        from datetime import datetime, timezone
        day = utc_day or datetime.now(timezone.utc).date().isoformat()
        quota_id = "zero-daily-usage:" + day
        with self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM zero_video_jobs WHERE id = ?", (quota_id,)
            ).fetchone()
        if not row:
            return 0
        try:
            payload = json.loads(row[0])
            accepted = payload.get("accepted_jobs", 0) if isinstance(payload, dict) else 0
            return max(0, int(accepted))
        except (TypeError, ValueError, json.JSONDecodeError):
            return 0

    def create_job_if_allowed(
        self, job: dict[str, Any], daily_limit: int = 3, max_concurrent: int = 1, utc_day: str | None = None
    ) -> tuple[bool, str, int]:
        """Atomically reserve one daily job and persist it before returning success."""
        if daily_limit < 1 or max_concurrent < 1:
            raise ValueError("Job limits must be positive.")
        from datetime import datetime, timezone
        day = utc_day or datetime.now(timezone.utc).date().isoformat()
        if len(day) != 10:
            raise ValueError("Invalid UTC day key.")
        payload = json.dumps(job, separators=(",", ":"), ensure_ascii=False)
        quota_id = "zero-daily-usage:" + day
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute("SELECT payload FROM zero_video_jobs").fetchall()
            active = 0
            for (raw_payload,) in rows:
                try:
                    existing = json.loads(raw_payload)
                except (TypeError, json.JSONDecodeError):
                    continue
                if isinstance(existing, dict) and existing.get("status") in {"queued", "running", "cancel_requested"}:
                    active += 1
            if active >= max_concurrent:
                connection.rollback()
                return False, "concurrency_limit", active
            quota_row = connection.execute("SELECT payload FROM zero_video_jobs WHERE id = ?", (quota_id,)).fetchone()
            try:
                accepted = int(json.loads(quota_row[0]).get("accepted_jobs", 0)) if quota_row else 0
            except (TypeError, ValueError, json.JSONDecodeError):
                accepted = daily_limit
            if accepted >= daily_limit:
                connection.rollback()
                return False, "daily_limit", accepted
            quota_payload = json.dumps({"id": quota_id, "kind": "daily_usage", "status": "quota", "utc_day": day, "accepted_jobs": accepted + 1}, separators=(",", ":"))
            connection.execute(
                "INSERT INTO zero_video_jobs (id, payload, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) "
                "ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP",
                (quota_id, quota_payload),
            )
            connection.execute(
                "INSERT INTO zero_video_jobs (id, payload, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
                (str(job["id"]), payload),
            )
            connection.commit()
            return True, "accepted", accepted + 1
    def request_cancel(self, job_id: str) -> dict[str, Any] | None:
        """Persist a cancellation request without pretending active inference stopped."""
        from datetime import datetime, timezone
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT payload FROM zero_video_jobs WHERE id = ?", (job_id,)
            ).fetchone()
            if not row:
                connection.rollback()
                return None
            try:
                job = json.loads(row[0])
            except (TypeError, json.JSONDecodeError):
                connection.rollback()
                return None
            if not isinstance(job, dict) or job.get("id") != job_id:
                connection.rollback()
                return None
            status = job.get("status")
            if status == "queued":
                job.update({
                    "status": "cancelled",
                    "cancelled_at": datetime.now(timezone.utc).isoformat(),
                    "cancel_reason": "Auftrag vor GPU-Start abgebrochen.",
                })
            elif status == "running":
                job.update({
                    "status": "cancel_requested",
                    "cancel_requested_at": datetime.now(timezone.utc).isoformat(),
                    "cancel_reason": "Abbruch angefordert; laufender GPU-Inferenzschritt wird sicher beendet.",
                })
            elif status in {"cancel_requested", "cancelled", "succeeded", "failed"}:
                pass
            else:
                connection.rollback()
                return None
            payload = json.dumps(job, separators=(",", ":"), ensure_ascii=False)
            connection.execute(
                "UPDATE zero_video_jobs SET payload = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (payload, job_id),
            )
            connection.commit()
            return job

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
            if job.get("kind") == "daily_usage":
                continue

            if job.get("status") in {"queued", "running"}:
                job.update({
                    "status": "failed",
                    "finished_at": job.get("finished_at") or job.get("updated_at") or job.get("created_at"),
                    "error": "GPU-Worker wurde während dieses Auftrags neu gestartet. Auftrag wurde nicht automatisch erneut ausgeführt.",
                })
                self.save(job)
            elif job.get("status") == "cancel_requested":
                job.update({
                    "status": "cancelled",
                    "finished_at": job.get("finished_at") or job.get("cancel_requested_at"),
                    "cancel_reason": "Worker-Neustart beendet den zuvor angeforderten Abbruch; kein GPU-Prozess läuft weiter.",
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

    def list_jobs(self, limit: int = 50) -> list[dict[str, Any]]:
        """Return the newest persisted jobs after applying safe restart recovery."""
        if not 1 <= limit <= 50:
            raise ValueError("Job list limit must be between 1 and 50.")
        jobs = self.load_all()
        ordered = sorted(
            jobs.values(),
            key=lambda job: str(job.get("created_at") or ""),
            reverse=True,
        )
        return ordered[:limit]

    def prune_completed(self, max_jobs: int = 50, retain_jobs: int = 40) -> list[dict[str, Any]]:
        if max_jobs < 1 or retain_jobs < 1 or retain_jobs >= max_jobs:
            raise ValueError("Invalid job retention limits.")
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT id, payload FROM zero_video_jobs ORDER BY updated_at DESC"
            ).fetchall()
        if len(rows) < max_jobs:
            return []
        completed: list[dict[str, Any]] = []
        for job_id, payload in rows:
            try:
                job = json.loads(payload)
            except (TypeError, json.JSONDecodeError):
                continue
            if isinstance(job, dict) and job.get("status") in {"succeeded", "failed"}:
                completed.append(job)
        completed.sort(key=lambda job: str(job.get("created_at", "")))
        remove_count = max(0, len(rows) - retain_jobs)
        removed = completed[:remove_count]
        for job in removed:
            self.delete(str(job["id"]))
        return removed
