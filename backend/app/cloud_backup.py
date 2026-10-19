"""Consistent local snapshots, private Hub storage, and fail-safe recovery.

One application process owns a bucket prefix. Publish an immutable snapshot
first, then its manifest; an interrupted upload never replaces the last backup.
"""

from __future__ import annotations

from datetime import UTC, datetime
from contextlib import closing
from pathlib import Path
import hashlib
import json
import logging
import os
import re
import sqlite3
import tempfile
import threading
import uuid

from .storage import PhraseStorage

logger = logging.getLogger(__name__)
PREFIX = "continuator-backups/"
MANIFEST = PREFIX + "latest.json"
SNAPSHOT_PATTERN = re.compile(
    r"continuator-backups/[a-f0-9]{32}-\d+-[a-f0-9]{32}\.sqlite3"
)


def checksum(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def inspect_snapshot(path: Path) -> tuple[str, int]:
    with closing(
        sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    ) as connection:
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Backup failed SQLite integrity validation")
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValueError("Backup has invalid references")
        row = connection.execute(
            "SELECT database_id, revision FROM backup_state"
        ).fetchone()
        if row is None:
            raise ValueError("Backup identity missing")
        return str(row[0]), int(row[1])


class HubBucket:
    def __init__(self, bucket_id: str) -> None:
        from huggingface_hub import HfApi

        self.bucket_id = bucket_id
        self.api = HfApi(token=os.getenv("CONTINUATOR_BACKUP_TOKEN") or None)

    def check_private(self) -> None:
        if not self.api.bucket_info(self.bucket_id).private:
            raise ValueError("Database backups require a private bucket")

    def download(self, name: str, destination: Path) -> None:
        self.api.download_bucket_files(
            self.bucket_id, files=[(name, destination)], raise_on_missing_files=True
        )

    def manifest(self) -> dict | None:
        # Listing distinguishes an empty bucket from permission/network errors.
        if not any(
            item.path == MANIFEST
            for item in self.api.list_bucket_tree(self.bucket_id, prefix=PREFIX)
        ):
            return None
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            self.download(MANIFEST, path)
            return json.loads(path.read_text())

    def upload(self, source: Path | bytes, name: str) -> None:
        self.api.batch_bucket_files(self.bucket_id, add=[(source, name)])

    def prune(self, keep: list[str]) -> None:
        old = [
            item.path
            for item in self.api.list_bucket_tree(self.bucket_id, prefix=PREFIX)
            if SNAPSHOT_PATTERN.fullmatch(item.path) and item.path not in keep
        ]
        if old:
            self.api.batch_bucket_files(self.bucket_id, delete=old)


class CloudBackup:
    def __init__(self, db_path: Path, remote=None, interval: float = 5) -> None:
        self.db_path = db_path
        self.remote = remote
        self.interval = interval
        self.storage: PhraseStorage | None = None
        self._saved_identity: tuple[str, int] | None = None
        self._last_saved_at: str | None = None
        self._history: list[str] = []
        self._failed = False
        self._lock = threading.RLock()
        self._upload_lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def restore(self) -> None:
        """Run before opening SQLite. Never serve an empty DB after restore failure."""
        if self.remote is None:
            return
        self.remote.check_private()
        manifest = self.remote.manifest()
        if manifest is None:
            return
        name = manifest["snapshot"]
        if not SNAPSHOT_PATTERN.fullmatch(name):
            raise ValueError("Invalid backup snapshot path")
        identity = (str(manifest["database_id"]), int(manifest["revision"]))
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=self.db_path.parent) as directory:
            snapshot = Path(directory) / "restore.sqlite3"
            self.remote.download(name, snapshot)
            if checksum(snapshot) != manifest["sha256"]:
                raise ValueError("Backup checksum mismatch; refusing to start")
            if inspect_snapshot(snapshot) != identity:
                raise ValueError("Backup identity mismatch; refusing to start")
            replace = not self.db_path.exists() or self.db_path.stat().st_size == 0
            if not replace:
                local_identity = inspect_snapshot(self.db_path.resolve())
                if local_identity[0] != identity[0]:
                    raise ValueError(
                        "Local and cloud databases differ; manual recovery required"
                    )
                replace = local_identity[1] < identity[1]
            if replace:
                # No connection has opened yet; remove stale WAL sidecars before
                # atomically installing the validated, self-contained snapshot.
                for suffix in ("-wal", "-shm"):
                    Path(str(self.db_path) + suffix).unlink(missing_ok=True)
                with snapshot.open("rb") as handle:
                    os.fsync(handle.fileno())
                os.replace(snapshot, self.db_path)
        self._saved_identity = identity
        self._last_saved_at = manifest["saved_at"]
        self._history = manifest.get("history", [name])

    def start(self, storage: PhraseStorage) -> None:
        self.storage = storage
        if self.remote is None:
            return
        storage.on_commit = self._wake.set
        self._stop.clear()
        self._wake.set()
        self._thread = threading.Thread(
            target=self._run, name="cloud-backup", daemon=True
        )
        self._thread.start()

    def status(self) -> dict:
        if self.remote is None:
            return {"enabled": False, "status": "local", "last_saved_at": None}
        with self._lock:
            saved = self._saved_identity
            failed = self._failed
            saved_at = self._last_saved_at
        current = self.storage.backup_identity() if self.storage else None
        return {
            "enabled": True,
            "status": "failed"
            if failed
            else "saved"
            if saved == current and current
            else "saving",
            "last_saved_at": saved_at,
        }

    def save_once(self) -> bool:
        if self.remote is None or self.storage is None:
            return False
        with self._upload_lock:
            if self.storage.backup_identity() == self._saved_identity:
                return True
            try:
                with tempfile.TemporaryDirectory() as directory:
                    snapshot = Path(directory) / "snapshot.sqlite3"
                    identity = self.storage.snapshot(snapshot)
                    name = f"{PREFIX}{identity[0]}-{identity[1]}-{uuid.uuid4().hex}.sqlite3"
                    self.remote.check_private()
                    self.remote.upload(snapshot, name)
                    saved_at = datetime.now(UTC).isoformat(timespec="seconds")
                    history = [name, *self._history[:2]]
                    manifest = {
                        "version": 1,
                        "snapshot": name,
                        "database_id": identity[0],
                        "revision": identity[1],
                        "sha256": checksum(snapshot),
                        "saved_at": saved_at,
                        "history": history,
                    }
                    self.remote.upload(json.dumps(manifest).encode(), MANIFEST)
                with self._lock:
                    self._saved_identity = identity
                    self._last_saved_at = saved_at
                    self._history = history
                    self._failed = False
                try:
                    self.remote.prune(history)
                except Exception:
                    logger.warning("Cloud backup saved; old snapshot cleanup failed")
                return True
            except Exception:
                # Do not expose credentials, private URLs or remote response bodies.
                logger.warning("Cloud backup failed; retaining local data and retrying")
                with self._lock:
                    self._failed = True
                return False

    def _run(self) -> None:
        while not self._stop.is_set():
            self._wake.wait(timeout=self.interval)
            self._wake.clear()
            if self._stop.wait(self.interval):
                break
            self.save_once()

    def close(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=2)
        # A final snapshot on graceful shutdown; the normal worker also retries
        # failures independently of further user activity.
        self.save_once()
