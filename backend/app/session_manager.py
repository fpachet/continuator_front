from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
import threading
import uuid

from .continuator_adapter import ContinuatorSessionEngine, NoContinuationAvailable
from .schemas import (
    ContinueRequest,
    ContinueResponse,
    CreateSessionRequest,
    CreateSessionResponse,
    HistoryItem,
    MemoryPhraseItem,
    ResetSessionResponse,
    SessionConfiguration,
    SessionHistoryResponse,
    SessionMemoryResponse,
    SessionMemorySummary,
    UpdateSessionSettingsRequest,
    UpdateSessionSettingsResponse,
)
from .storage import PhraseStorage


class UnknownSessionError(KeyError):
    """Raised when a session identifier is unknown."""


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


@dataclass
class SessionState:
    session_id: str
    created_at: str
    last_seen_at: str
    configuration: SessionConfiguration
    engine: ContinuatorSessionEngine


class SessionManager:
    def __init__(
        self,
        storage: PhraseStorage,
        seed_midi_file: Path | None = None,
        seed_midi_folder: Path | None = None,
    ) -> None:
        self.storage = storage
        self.seed_midi_file = seed_midi_file
        self.seed_midi_folder = seed_midi_folder
        self._sessions: dict[str, SessionState] = {}
        self._lock = threading.RLock()

    @property
    def seeded(self) -> bool:
        return bool(self.seed_midi_file or self.seed_midi_folder)

    def create_session(self, request: CreateSessionRequest) -> CreateSessionResponse:
        created_at = utc_now_iso()
        session_id = uuid.uuid4().hex
        configuration = SessionConfiguration(
            learn_input=request.learn_input,
            transposition=request.transposition,
            forget_past=request.forget_past,
            keep_last_inputs=request.keep_last_inputs,
            decay_mode=request.decay_mode,
            seeded=self.seeded,
        )
        engine = ContinuatorSessionEngine(
            learn_input=request.learn_input,
            transposition=request.transposition,
            forget_past=request.forget_past,
            keep_last_inputs=request.keep_last_inputs,
            decay_mode=request.decay_mode,
            seed_midi_file=self.seed_midi_file,
            seed_midi_folder=self.seed_midi_folder,
        )
        state = SessionState(
            session_id=session_id,
            created_at=created_at,
            last_seen_at=created_at,
            configuration=configuration,
            engine=engine,
        )

        with self._lock:
            self._sessions[session_id] = state

        self.storage.create_session(
            session_id=session_id,
            created_at=created_at,
            metadata=configuration.model_dump(),
        )
        return CreateSessionResponse(
            session_id=session_id,
            created_at=created_at,
            configuration=configuration,
        )

    def _require_session(self, session_id: str) -> SessionState:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise UnknownSessionError(session_id)
        return session

    def continue_phrase(self, request: ContinueRequest) -> ContinueResponse:
        state = self._require_session(request.session_id)
        created_at = utc_now_iso()
        request_id = uuid.uuid4().hex
        input_phrase, generated_phrase, status_message = state.engine.continue_phrase(
            request.phrase,
            learn_input=request.learn_input,
            continuation_note_count=request.continuation_note_count,
        )

        state.last_seen_at = created_at
        self.storage.touch_session(state.session_id, created_at)
        self.storage.log_phrase(
            phrase_id=uuid.uuid4().hex,
            request_id=request_id,
            session_id=state.session_id,
            kind="input",
            created_at=created_at,
            payload=input_phrase.model_dump(mode="json"),
        )
        self.storage.log_phrase(
            phrase_id=uuid.uuid4().hex,
            request_id=request_id,
            session_id=state.session_id,
            kind="generated",
            created_at=created_at,
            payload=generated_phrase.model_dump(mode="json"),
        )

        return ContinueResponse(
            session_id=state.session_id,
            request_id=request_id,
            created_at=created_at,
            input_phrase=input_phrase,
            generated_phrase=generated_phrase,
            status_message=status_message,
        )

    def get_history(self, session_id: str, limit: int = 20) -> SessionHistoryResponse:
        if not self.storage.session_exists(session_id):
            raise UnknownSessionError(session_id)
        items = [
            HistoryItem.model_validate(item)
            for item in self.storage.get_history(session_id, limit=limit)
        ]
        return SessionHistoryResponse(session_id=session_id, items=items)

    def get_memory(self, session_id: str) -> SessionMemoryResponse:
        state = self._require_session(session_id)
        payloads, seeded_count = state.engine.get_memory_snapshot()
        items = [
            MemoryPhraseItem(
                slot=index + 1,
                source="seed" if index < seeded_count else "live",
                event_count=payload.event_count,
                note_count=payload.note_count,
                duration_seconds=payload.duration_seconds,
                payload=payload,
            )
            for index, payload in enumerate(payloads)
        ]
        summary = SessionMemorySummary(
            active_phrase_count=len(items),
            seeded_phrase_count=seeded_count,
            live_phrase_count=max(0, len(items) - seeded_count),
        )
        return SessionMemoryResponse(
            session_id=session_id,
            configuration=state.configuration,
            summary=summary,
            items=items,
        )

    def reset_session(self, session_id: str) -> ResetSessionResponse:
        state = self._require_session(session_id)
        state.engine.reset()
        state.last_seen_at = utc_now_iso()
        self.storage.touch_session(session_id, state.last_seen_at)
        return ResetSessionResponse(
            session_id=session_id,
            reset_at=state.last_seen_at,
            configuration=state.configuration,
        )

    def update_session_settings(
        self,
        session_id: str,
        request: UpdateSessionSettingsRequest,
    ) -> UpdateSessionSettingsResponse:
        state = self._require_session(session_id)
        updated_at = utc_now_iso()

        update_fields = request.model_dump(exclude_none=True)
        if not update_fields:
            return UpdateSessionSettingsResponse(
                session_id=session_id,
                updated_at=updated_at,
                configuration=state.configuration,
            )

        state.engine.apply_settings(**update_fields)
        state.configuration = state.configuration.model_copy(update=update_fields)
        state.last_seen_at = updated_at
        self.storage.update_session_metadata(
            session_id=session_id,
            metadata=state.configuration.model_dump(),
            last_seen_at=updated_at,
        )
        return UpdateSessionSettingsResponse(
            session_id=session_id,
            updated_at=updated_at,
            configuration=state.configuration,
        )


__all__ = [
    "NoContinuationAvailable",
    "SessionManager",
    "UnknownSessionError",
]
