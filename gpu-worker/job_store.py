from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


_PERSISTENT_FILESYSTEMS = {
    "ext2", "ext3", "ext4", "xfs", "btrfs", "zfs",
    "nfs", "nfs4", "cifs", "ceph", "glusterfs",
}


def has_persistent_mount(path: str | Path, mountinfo_text: str | None = None) -> bool:
    """Return true only when path is backed by a non-ephemeral mounted filesystem."""
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
            "GPU worker storage is ephemeral. Configure WAN_OUTPUT_DIR on a persistent volume before accepting jobs."
        )


class PersistentJobStore:
    """SQLite-backed, principal-scoped job metadata for a single GPU worker."""

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
            # Additive migration: existing persisted jobs remain readable.
            columns = {row[1] for row in connection.execute("PRAGMA table_info(zero_video_jobs)")}
            for name in ("principal_hash", "idempotency_key_hash", "request_fingerprint"):
                if name not in columns:
                    connection.execute(f"ALTER TABLE zero_video_jobs ADD COLUMN {name} TEXT")
            connection.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS zero_video_jobs_idempotency
                ON zero_video_jobs(principal_hash, idempotency_key_hash)
                WHERE principal_hash IS NOT NULL AND idempotency_key_hash IS NOT NULL
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS zero_video_jobs_principal_updated ON zero_video_jobs(principal_hash, updated_at DESC)"
            )

    def save(self, job: dict[str, Any]) -> None:
        payload = json.dumps(job, separators=(",", ":"), ensure_ascii=False)
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO zero_video_jobs
                    (id, payload, updated_at, principal_hash, idempotency_key_hash, request_fingerprint)
                VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = CURRENT_TIMESTAMP,
                    principal_hash = excluded.principal_hash,
                    idempotency_key_hash = excluded.idempotency_key_hash,
                    request_fingerprint = excluded.request_fingerprint
                """,
                (
                    str(job["id"]), payload, job.get("principal_hash"),
                    job.get("idempotency_key_hash"), job.get("request_fingerprint"),
                ),
            )

    def create_or_get(self, job: dict[str, Any]) -> tuple[dict[str, Any], bool, bool]:
        """Atomically create a job or return the existing principal/key match.

        Returns (job, replayed, fingerprint_conflict). The caller must not
        enqueue work when replayed is true.
        """
        principal_hash = str(job["principal_hash"])
        key_hash = str(job["idempotency_key_hash"])
        fingerprint = str(job["request_fingerprint"])
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT payload, request_fingerprint FROM zero_video_jobs
                WHERE principal_hash = ? AND idempotency_key_hash = ?
                """,
                (principal_hash, key_hash),
            ).fetchone()
            if row:
                existing = json.loads(row[0])
                return existing, True, str(row[1]) != fingerprint
            connection.execute(
                """
                INSERT INTO zero_video_jobs
                    (id, payload, updated_at, principal_hash, idempotency_key_hash, request_fingerprint)
                VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
                """,
                (str(job["id"]), json.dumps(job, separators=(",", ":"), ensure_ascii=False),
                 principal_hash, key_hash, fingerprint),
            )
            return dict(job), False, False

    def delete(self, job_id: str) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM zero_video_jobs WHERE id = ?", (job_id,))

    def list_by_principal(self, principal_hash: str, project_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        bounded_limit = max(1, min(int(limit), 50))
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT payload FROM zero_video_jobs
                WHERE principal_hash = ?
                ORDER BY updated_at DESC LIMIT ?
                """,
                (principal_hash, bounded_limit),
            ).fetchall()
        jobs: list[dict[str, Any]] = []
        for (payload,) in rows:
            try:
                job = json.loads(payload)
            except (TypeError, json.JSONDecodeError):
                continue
            if isinstance(job, dict) and (project_id is None or job.get("project_id") == project_id):
                jobs.append(job)
        return jobs

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
