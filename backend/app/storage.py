from __future__ import annotations

from pathlib import Path
import json
import sqlite3
import threading


SCHEMA_SQL = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS phrases (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('input', 'generated')),
    created_at TEXT NOT NULL,
    event_count INTEGER NOT NULL,
    note_count INTEGER NOT NULL,
    duration_seconds REAL NOT NULL,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_phrases_session_created
    ON phrases(session_id, created_at DESC);
"""


class PhraseStorage:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._lock, self._connect() as connection:
            connection.executescript(SCHEMA_SQL)

    def create_session(self, session_id: str, created_at: str, metadata: dict[str, object]) -> None:
        payload = json.dumps(metadata, ensure_ascii=False)
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO sessions (id, created_at, last_seen_at, metadata_json)
                VALUES (?, ?, ?, ?)
                """,
                (session_id, created_at, created_at, payload),
            )
            connection.commit()

    def touch_session(self, session_id: str, last_seen_at: str) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                "UPDATE sessions SET last_seen_at = ? WHERE id = ?",
                (last_seen_at, session_id),
            )
            connection.commit()

    def update_session_metadata(
        self,
        session_id: str,
        metadata: dict[str, object],
        last_seen_at: str | None = None,
    ) -> None:
        payload = json.dumps(metadata, ensure_ascii=False)
        with self._lock, self._connect() as connection:
            if last_seen_at is None:
                connection.execute(
                    "UPDATE sessions SET metadata_json = ? WHERE id = ?",
                    (payload, session_id),
                )
            else:
                connection.execute(
                    """
                    UPDATE sessions
                    SET metadata_json = ?, last_seen_at = ?
                    WHERE id = ?
                    """,
                    (payload, last_seen_at, session_id),
                )
            connection.commit()

    def session_exists(self, session_id: str) -> bool:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT 1 FROM sessions WHERE id = ? LIMIT 1",
                (session_id,),
            ).fetchone()
        return row is not None

    def log_phrase(
        self,
        phrase_id: str,
        request_id: str,
        session_id: str,
        kind: str,
        created_at: str,
        payload: dict[str, object],
    ) -> None:
        serialized_payload = json.dumps(payload, ensure_ascii=False)
        event_count = int(payload.get("event_count", 0))
        note_count = int(payload.get("note_count", 0))
        duration_seconds = float(payload.get("duration_seconds", 0.0))

        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO phrases (
                    id,
                    request_id,
                    session_id,
                    kind,
                    created_at,
                    event_count,
                    note_count,
                    duration_seconds,
                    payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    phrase_id,
                    request_id,
                    session_id,
                    kind,
                    created_at,
                    event_count,
                    note_count,
                    duration_seconds,
                    serialized_payload,
                ),
            )
            connection.commit()

    def get_history(self, session_id: str, limit: int = 20) -> list[dict[str, object]]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    id,
                    request_id,
                    kind,
                    created_at,
                    event_count,
                    note_count,
                    duration_seconds,
                    payload_json
                FROM phrases
                WHERE session_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (session_id, limit),
            ).fetchall()

        return [
            {
                "id": row["id"],
                "request_id": row["request_id"],
                "kind": row["kind"],
                "created_at": row["created_at"],
                "event_count": row["event_count"],
                "note_count": row["note_count"],
                "duration_seconds": row["duration_seconds"],
                "payload": json.loads(row["payload_json"]),
            }
            for row in rows
        ]
