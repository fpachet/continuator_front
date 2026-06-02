from __future__ import annotations

from pathlib import Path
import json
import sqlite3
import threading


SCHEMA_SQL = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_normalized TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user
    ON auth_tokens(user_id);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_reset_at TEXT,
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
    learned INTEGER CHECK(learned IN (0, 1)),
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
            self._migrate_schema(connection)
            connection.commit()

    def _migrate_schema(self, connection: sqlite3.Connection) -> None:
        self._ensure_column(connection, "sessions", "user_id", "TEXT")
        self._ensure_column(connection, "sessions", "last_reset_at", "TEXT")
        self._ensure_column(
            connection,
            "phrases",
            "learned",
            "INTEGER CHECK(learned IN (0, 1))",
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_sessions_user_last_seen
            ON sessions(user_id, last_seen_at DESC)
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_auth_tokens_user
            ON auth_tokens(user_id)
            """
        )

    def _ensure_column(
        self,
        connection: sqlite3.Connection,
        table_name: str,
        column_name: str,
        column_definition: str,
    ) -> None:
        rows = connection.execute(f"PRAGMA table_info({table_name})").fetchall()
        columns = {str(row["name"]) for row in rows}
        if column_name in columns:
            return
        connection.execute(
            f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_definition}"
        )

    def create_user(
        self,
        user_id: str,
        username: str,
        username_normalized: str,
        password_hash: str,
        password_salt: str,
        created_at: str,
    ) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO users (
                    id,
                    username,
                    username_normalized,
                    password_hash,
                    password_salt,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    username,
                    username_normalized,
                    password_hash,
                    password_salt,
                    created_at,
                ),
            )
            connection.commit()

    def get_user_by_username(self, username_normalized: str) -> dict[str, object] | None:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                """
                SELECT id, username, password_hash, password_salt, created_at
                FROM users
                WHERE username_normalized = ?
                LIMIT 1
                """,
                (username_normalized,),
            ).fetchone()
        if row is None:
            return None
        return dict(row)

    def get_user_for_token(
        self,
        token_hash: str,
        now_iso: str,
    ) -> dict[str, object] | None:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                """
                SELECT users.id, users.username, users.created_at
                FROM auth_tokens
                JOIN users ON users.id = auth_tokens.user_id
                WHERE auth_tokens.token_hash = ?
                  AND auth_tokens.expires_at > ?
                LIMIT 1
                """,
                (token_hash, now_iso),
            ).fetchone()
        if row is None:
            return None
        return dict(row)

    def create_auth_token(
        self,
        token_hash: str,
        user_id: str,
        created_at: str,
        expires_at: str,
    ) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO auth_tokens (token_hash, user_id, created_at, expires_at)
                VALUES (?, ?, ?, ?)
                """,
                (token_hash, user_id, created_at, expires_at),
            )
            connection.commit()

    def delete_auth_token(self, token_hash: str) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                "DELETE FROM auth_tokens WHERE token_hash = ?",
                (token_hash,),
            )
            connection.commit()

    def create_session(
        self,
        session_id: str,
        user_id: str | None,
        created_at: str,
        metadata: dict[str, object],
    ) -> None:
        payload = json.dumps(metadata, ensure_ascii=False)
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO sessions (
                    id,
                    user_id,
                    created_at,
                    last_seen_at,
                    last_reset_at,
                    metadata_json
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (session_id, user_id, created_at, created_at, None, payload),
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

    def mark_session_reset(
        self,
        session_id: str,
        last_reset_at: str,
        last_seen_at: str,
    ) -> None:
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                UPDATE sessions
                SET last_reset_at = ?, last_seen_at = ?
                WHERE id = ?
                """,
                (last_reset_at, last_seen_at, session_id),
            )
            connection.commit()

    def session_exists(
        self,
        session_id: str,
        user_id: str | None,
        *,
        allow_guest: bool = False,
    ) -> bool:
        with self._lock, self._connect() as connection:
            if user_id is None:
                row = connection.execute(
                    "SELECT 1 FROM sessions WHERE id = ? AND user_id IS NULL LIMIT 1",
                    (session_id,),
                ).fetchone()
            else:
                if allow_guest:
                    row = connection.execute(
                        """
                        SELECT 1
                        FROM sessions
                        WHERE id = ? AND (user_id = ? OR user_id IS NULL)
                        LIMIT 1
                        """,
                        (session_id, user_id),
                    ).fetchone()
                else:
                    row = connection.execute(
                        "SELECT 1 FROM sessions WHERE id = ? AND user_id = ? LIMIT 1",
                        (session_id, user_id),
                    ).fetchone()
        return row is not None

    def get_session_record(
        self,
        session_id: str,
        user_id: str | None,
        *,
        allow_guest: bool = False,
    ) -> dict[str, object] | None:
        with self._lock, self._connect() as connection:
            if user_id is None:
                row = connection.execute(
                    """
                    SELECT id, user_id, created_at, last_seen_at, last_reset_at, metadata_json
                    FROM sessions
                    WHERE id = ? AND user_id IS NULL
                    LIMIT 1
                    """,
                    (session_id,),
                ).fetchone()
            else:
                if allow_guest:
                    row = connection.execute(
                        """
                        SELECT id, user_id, created_at, last_seen_at, last_reset_at, metadata_json
                        FROM sessions
                        WHERE id = ? AND (user_id = ? OR user_id IS NULL)
                        LIMIT 1
                        """,
                        (session_id, user_id),
                    ).fetchone()
                else:
                    row = connection.execute(
                        """
                        SELECT id, user_id, created_at, last_seen_at, last_reset_at, metadata_json
                        FROM sessions
                        WHERE id = ? AND user_id = ?
                        LIMIT 1
                        """,
                        (session_id, user_id),
                    ).fetchone()
        if row is None:
            return None
        return {
            "id": row["id"],
            "user_id": row["user_id"],
            "created_at": row["created_at"],
            "last_seen_at": row["last_seen_at"],
            "last_reset_at": row["last_reset_at"],
            "metadata": json.loads(row["metadata_json"]),
        }

    def list_sessions_for_user(
        self,
        user_id: str,
        limit: int = 24,
    ) -> list[dict[str, object]]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    sessions.id,
                    sessions.created_at,
                    sessions.last_seen_at,
                    sessions.last_reset_at,
                    sessions.metadata_json,
                    COUNT(phrases.id) AS phrase_count,
                    SUM(CASE WHEN phrases.kind = 'input' THEN 1 ELSE 0 END) AS input_phrase_count,
                    SUM(
                        CASE
                            WHEN phrases.kind = 'input'
                             AND COALESCE(phrases.learned, 1) = 1
                             AND (
                                sessions.last_reset_at IS NULL
                                OR phrases.created_at > sessions.last_reset_at
                             )
                            THEN 1
                            ELSE 0
                        END
                    ) AS active_learned_phrase_count
                FROM sessions
                LEFT JOIN phrases ON phrases.session_id = sessions.id
                WHERE sessions.user_id = ?
                GROUP BY
                    sessions.id,
                    sessions.created_at,
                    sessions.last_seen_at,
                    sessions.last_reset_at,
                    sessions.metadata_json
                ORDER BY sessions.last_seen_at DESC
                LIMIT ?
                """,
                (user_id, limit),
            ).fetchall()

        return [
            {
                "session_id": row["id"],
                "created_at": row["created_at"],
                "last_seen_at": row["last_seen_at"],
                "last_reset_at": row["last_reset_at"],
                "configuration": json.loads(row["metadata_json"]),
                "phrase_count": int(row["phrase_count"] or 0),
                "input_phrase_count": int(row["input_phrase_count"] or 0),
                "active_learned_phrase_count": int(row["active_learned_phrase_count"] or 0),
            }
            for row in rows
        ]

    def get_rebuild_phrases(
        self,
        session_id: str,
        last_reset_at: str | None = None,
    ) -> list[dict[str, object]]:
        query = """
            SELECT payload_json
            FROM phrases
            WHERE session_id = ?
              AND kind = 'input'
              AND COALESCE(learned, 1) = 1
        """
        params: list[object] = [session_id]
        if last_reset_at is not None:
            query += " AND created_at > ?"
            params.append(last_reset_at)
        query += " ORDER BY created_at ASC, id ASC"

        with self._lock, self._connect() as connection:
            rows = connection.execute(query, params).fetchall()

        return [json.loads(str(row["payload_json"])) for row in rows]

    def get_rebuild_phrase_records(
        self,
        session_id: str,
        last_reset_at: str | None = None,
    ) -> list[dict[str, object]]:
        query = """
            SELECT id, payload_json
            FROM phrases
            WHERE session_id = ?
              AND kind = 'input'
              AND COALESCE(learned, 1) = 1
        """
        params: list[object] = [session_id]
        if last_reset_at is not None:
            query += " AND created_at > ?"
            params.append(last_reset_at)
        query += " ORDER BY created_at ASC, id ASC"

        with self._lock, self._connect() as connection:
            rows = connection.execute(query, params).fetchall()

        return [
            {
                "id": row["id"],
                "payload": json.loads(str(row["payload_json"])),
            }
            for row in rows
        ]

    def keep_only_active_learned_phrases(
        self,
        session_id: str,
        phrase_ids_to_keep: list[str],
        last_reset_at: str | None = None,
    ) -> int:
        query = """
            UPDATE phrases
            SET learned = 0
            WHERE session_id = ?
              AND kind = 'input'
              AND COALESCE(learned, 1) = 1
        """
        params: list[object] = [session_id]
        if last_reset_at is not None:
            query += " AND created_at > ?"
            params.append(last_reset_at)
        if phrase_ids_to_keep:
            placeholders = ", ".join("?" for _ in phrase_ids_to_keep)
            query += f" AND id NOT IN ({placeholders})"
            params.extend(phrase_ids_to_keep)

        with self._lock, self._connect() as connection:
            cursor = connection.execute(query, params)
            connection.commit()
        return int(cursor.rowcount)

    def count_continuation_requests(
        self,
        session_id: str,
        last_reset_at: str | None = None,
    ) -> int:
        query = """
            SELECT COUNT(DISTINCT input.request_id) AS count
            FROM phrases AS input
            WHERE input.session_id = ?
              AND input.kind = 'input'
              AND EXISTS (
                  SELECT 1
                  FROM phrases AS generated
                  WHERE generated.session_id = input.session_id
                    AND generated.request_id = input.request_id
                    AND generated.kind = 'generated'
              )
        """
        params: list[object] = [session_id]
        if last_reset_at is not None:
            query += " AND input.created_at > ?"
            params.append(last_reset_at)

        with self._lock, self._connect() as connection:
            row = connection.execute(query, params).fetchone()

        return int(row["count"] or 0) if row is not None else 0

    def log_phrase(
        self,
        phrase_id: str,
        request_id: str,
        session_id: str,
        kind: str,
        created_at: str,
        learned: bool | None,
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
                    learned,
                    payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    None if learned is None else int(learned),
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

    def get_played_and_generated_phrases(self, session_id: str) -> list[dict[str, object]]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    phrases.id,
                    phrases.request_id,
                    phrases.kind,
                    phrases.created_at,
                    phrases.event_count,
                    phrases.note_count,
                    phrases.duration_seconds,
                    phrases.payload_json
                FROM phrases
                WHERE phrases.session_id = ?
                  AND phrases.event_count > 0
                  AND (
                    phrases.kind = 'generated'
                    OR (
                      phrases.kind = 'input'
                      AND EXISTS (
                        SELECT 1
                        FROM phrases AS generated
                        WHERE generated.session_id = phrases.session_id
                          AND generated.request_id = phrases.request_id
                          AND generated.kind = 'generated'
                          AND generated.event_count > 0
                      )
                    )
                  )
                ORDER BY
                    phrases.created_at ASC,
                    phrases.request_id ASC,
                    CASE phrases.kind WHEN 'input' THEN 0 ELSE 1 END,
                    phrases.id ASC
                """,
                (session_id,),
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
