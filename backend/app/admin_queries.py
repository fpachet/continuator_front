"""Read-only administration queries with explicit public field selection."""

import json

from .storage import PhraseStorage

USER_STATS = """
WITH phrase_stats AS (
    SELECT session_id, COUNT(*) AS phrases,
           SUM(kind = 'input') AS inputs, SUM(kind = 'generated') AS generated
    FROM phrases GROUP BY session_id
), user_stats AS (
    SELECT s.user_id, COUNT(*) AS sessions, MAX(s.last_seen_at) AS last_session_at,
           SUM(COALESCE(p.phrases, 0)) AS phrases,
           SUM(COALESCE(p.inputs, 0)) AS inputs,
           SUM(COALESCE(p.generated, 0)) AS generated
    FROM sessions s LEFT JOIN phrase_stats p ON p.session_id = s.id
    GROUP BY s.user_id
)
"""
USER_FIELDS = """
SELECT u.id, u.username, u.created_at, u.last_login_at,
       COALESCE(s.sessions, 0) AS session_count,
       COALESCE(s.phrases, 0) AS phrase_count,
       COALESCE(s.inputs, 0) AS input_phrase_count,
       COALESCE(s.generated, 0) AS generated_phrase_count,
       MAX(COALESCE(u.last_login_at, u.created_at),
           COALESCE(s.last_session_at, u.created_at)) AS last_activity_at
FROM users u LEFT JOIN user_stats s ON s.user_id = u.id
"""


class AdminQueries:
    def __init__(self, storage: PhraseStorage):
        self.storage = storage

    def identity(self, user_id: str) -> dict | None:
        with self.storage._connect() as connection:
            row = connection.execute(
                "SELECT id, username FROM users WHERE id = ?", (user_id,)
            ).fetchone()
        return dict(row) if row else None

    def overview(self) -> dict:
        with self.storage._connect() as connection:
            return dict(
                connection.execute("""
                SELECT (SELECT COUNT(*) FROM users) AS registered_users,
                       (SELECT COUNT(*) FROM sessions) AS total_sessions,
                       (SELECT COUNT(*) FROM sessions WHERE user_id IS NULL) AS guest_sessions,
                       (SELECT COUNT(*) FROM phrases WHERE kind = 'input') AS input_phrases,
                       (SELECT COUNT(*) FROM phrases WHERE kind = 'generated') AS generated_phrases,
                       (SELECT COUNT(*) FROM phrases p JOIN sessions s ON s.id = p.session_id
                        WHERE s.user_id IS NULL) AS guest_phrases
            """).fetchone()
            )

    def users(self, query: str = "", limit: int = 50, offset: int = 0) -> dict:
        pattern = f"%{query.casefold()}%"
        with self.storage._connect() as connection:
            total = connection.execute(
                "SELECT COUNT(*) FROM users WHERE username_normalized LIKE ?",
                (pattern,),
            ).fetchone()[0]
            rows = connection.execute(
                USER_STATS
                + USER_FIELDS
                + " WHERE u.username_normalized LIKE ? ORDER BY last_activity_at DESC, u.id LIMIT ? OFFSET ?",
                (pattern, limit, offset),
            ).fetchall()
        return {
            "items": [dict(row) for row in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    def activity(self, user_id: str | None = None, limit: int = 50) -> list[dict]:
        with self.storage._connect() as connection:
            rows = connection.execute(
                """
                WITH events AS (
                    SELECT 'account_registered' AS event_type, created_at, id AS user_id,
                           NULL AS actor_user_id, NULL AS session_id, NULL AS note_count,
                           NULL AS duration_seconds, 'user:' || id AS event_key FROM users
                    UNION ALL
                    SELECT event_type, created_at, user_id, actor_user_id, NULL, NULL, NULL,
                           'audit:' || id FROM audit_events
                    UNION ALL
                    SELECT 'session_created', created_at, user_id, NULL, id, NULL, NULL,
                           'session:' || id FROM sessions
                    UNION ALL
                    SELECT 'phrase_' || p.kind, p.created_at, s.user_id, NULL, s.id,
                           p.note_count, p.duration_seconds, 'phrase:' || p.id
                    FROM phrases p JOIN sessions s ON s.id = p.session_id
                )
                SELECT e.event_type, e.created_at, e.user_id, u.username,
                       actor.username AS actor_username, e.session_id, e.note_count, e.duration_seconds
                FROM events e LEFT JOIN users u ON u.id = e.user_id
                LEFT JOIN users actor ON actor.id = e.actor_user_id
                WHERE (? IS NULL OR e.user_id = ?)
                ORDER BY e.created_at DESC, e.event_key DESC LIMIT ?
            """,
                (user_id, user_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def user(self, user_id: str) -> dict | None:
        with self.storage._connect() as connection:
            row = connection.execute(
                USER_STATS + USER_FIELDS + " WHERE u.id = ?", (user_id,)
            ).fetchone()
            if row is None:
                return None
            sessions = connection.execute(
                """
                SELECT s.id, s.created_at, s.last_seen_at, s.metadata_json,
                       (SELECT COUNT(*) FROM phrases p WHERE p.session_id = s.id AND kind = 'input') AS input_phrase_count,
                       (SELECT COUNT(*) FROM phrases p WHERE p.session_id = s.id AND kind = 'generated') AS generated_phrase_count,
                       (SELECT COUNT(*) FROM memory_variants m WHERE m.session_id = s.id) AS memory_variant_count
                FROM sessions s WHERE s.user_id = ? ORDER BY s.last_seen_at DESC LIMIT 40
            """,
                (user_id,),
            ).fetchall()
        items = []
        for session in sessions:
            item = dict(session)
            metadata = json.loads(item.pop("metadata_json"))
            item["display_name"] = metadata.get("display_name") or item["id"][:8]
            item["markov_order"] = metadata.get("markov_order")
            items.append(item)
        return {
            "user": dict(row),
            "sessions": items,
            "activity": self.activity(user_id),
        }
