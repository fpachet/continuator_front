"""Serialize a session's engine, metadata and database updates as one operation."""

from __future__ import annotations

from functools import wraps
from inspect import signature


def session_operation(method):
    parameters = signature(method)

    @wraps(method)
    def run(self, *args, **kwargs):
        arguments = parameters.bind(self, *args, **kwargs).arguments
        session_id = arguments.get("session_id")
        if session_id is None:
            session_id = arguments["request"].session_id
        with self._session_lock(session_id):
            try:
                with self.storage.transaction():
                    return method(self, *args, **kwargs)
            except Exception:
                # Engine mutations cannot be rolled back by SQLite. Discard the
                # cached state so the next operation restores the last commit.
                with self._lock:
                    self._sessions.pop(session_id, None)
                raise

    return run
