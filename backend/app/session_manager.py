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
    MidiEvent,
    OpenSessionResponse,
    PhrasePayload,
    ResetSessionResponse,
    SessionConfiguration,
    SessionHistoryResponse,
    SessionMemoryResponse,
    SessionMemorySummary,
    UpdateSessionSettingsRequest,
    UpdateSessionSettingsResponse,
    UserSessionListItem,
    UserSessionsResponse,
)
from .storage import PhraseStorage


class UnknownSessionError(KeyError):
    """Raised when a session identifier is unknown."""


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


@dataclass
class SessionState:
    session_id: str
    owner_user_id: str | None
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

    def _build_configuration(self, request: CreateSessionRequest) -> SessionConfiguration:
        return SessionConfiguration(
            learn_input=request.learn_input,
            transposition=request.transposition,
            forget_past=request.forget_past,
            keep_last_inputs=request.keep_last_inputs,
            decay_mode=request.decay_mode,
            seeded=self.seeded,
        )

    def _build_engine(self, configuration: SessionConfiguration) -> ContinuatorSessionEngine:
        return ContinuatorSessionEngine(
            learn_input=configuration.learn_input,
            transposition=configuration.transposition,
            forget_past=configuration.forget_past,
            keep_last_inputs=configuration.keep_last_inputs,
            decay_mode=configuration.decay_mode,
            seed_midi_file=self.seed_midi_file,
            seed_midi_folder=self.seed_midi_folder,
        )

    def create_session(
        self,
        request: CreateSessionRequest,
        owner_user_id: str | None,
    ) -> CreateSessionResponse:
        created_at = utc_now_iso()
        session_id = uuid.uuid4().hex
        configuration = self._build_configuration(request)
        engine = self._build_engine(configuration)
        state = SessionState(
            session_id=session_id,
            owner_user_id=owner_user_id,
            created_at=created_at,
            last_seen_at=created_at,
            configuration=configuration,
            engine=engine,
        )

        with self._lock:
            self._sessions[session_id] = state

        self.storage.create_session(
            session_id=session_id,
            user_id=owner_user_id,
            created_at=created_at,
            metadata=configuration.model_dump(),
        )
        return CreateSessionResponse(
            session_id=session_id,
            created_at=created_at,
            configuration=configuration,
        )

    def _restore_session_state(
        self,
        session_record: dict[str, object],
    ) -> tuple[SessionState, int, bool]:
        session_id = str(session_record["id"])
        owner_user_id = (
            None if session_record["user_id"] is None else str(session_record["user_id"])
        )

        with self._lock:
            loaded_session = self._sessions.get(session_id)
        if loaded_session is not None:
            if not self._can_access_session(loaded_session, owner_user_id):
                raise UnknownSessionError(session_id)
            return loaded_session, 0, False

        configuration = SessionConfiguration.model_validate(session_record["metadata"])
        engine = self._build_engine(configuration)
        restored_phrase_count = 0
        for payload_data in self.storage.get_rebuild_phrases(
            session_id,
            last_reset_at=session_record.get("last_reset_at"),
        ):
            payload = PhrasePayload.model_validate(payload_data)
            phrase_events = [MidiEvent.model_validate(event) for event in payload.events]
            try:
                engine.learn_phrase_events(phrase_events)
            except NoContinuationAvailable:
                continue
            restored_phrase_count += 1

        restored_at = utc_now_iso()
        state = SessionState(
            session_id=session_id,
            owner_user_id=owner_user_id,
            created_at=str(session_record["created_at"]),
            last_seen_at=restored_at,
            configuration=configuration,
            engine=engine,
        )

        with self._lock:
            loaded_session = self._sessions.get(session_id)
            if loaded_session is not None:
                if not self._can_access_session(loaded_session, owner_user_id):
                    raise UnknownSessionError(session_id)
                return loaded_session, 0, False
            self._sessions[session_id] = state

        self.storage.touch_session(session_id, restored_at)
        return state, restored_phrase_count, True

    def _can_access_session(
        self,
        session: SessionState,
        owner_user_id: str | None,
    ) -> bool:
        if session.owner_user_id is None:
            return True
        return owner_user_id == session.owner_user_id

    def _require_session(self, session_id: str, owner_user_id: str | None) -> SessionState:
        with self._lock:
            session = self._sessions.get(session_id)
        if session is not None:
            if not self._can_access_session(session, owner_user_id):
                raise UnknownSessionError(session_id)
            return session

        session_record = self.storage.get_session_record(
            session_id,
            owner_user_id,
            allow_guest=True,
        )
        if session_record is None:
            raise UnknownSessionError(session_id)
        restored_state, _, _ = self._restore_session_state(session_record)
        return restored_state

    def open_session(self, session_id: str, owner_user_id: str) -> OpenSessionResponse:
        session_record = self.storage.get_session_record(session_id, owner_user_id)
        if session_record is None:
            raise UnknownSessionError(session_id)
        state, restored_phrase_count, restored_from_history = self._restore_session_state(
            session_record
        )
        if not restored_from_history:
            state.last_seen_at = utc_now_iso()
            self.storage.touch_session(session_id, state.last_seen_at)
        return OpenSessionResponse(
            session_id=state.session_id,
            created_at=state.created_at,
            last_seen_at=state.last_seen_at,
            configuration=state.configuration,
            restored_phrase_count=restored_phrase_count,
            restored_from_history=restored_from_history,
        )

    def list_user_sessions(self, owner_user_id: str, limit: int = 24) -> UserSessionsResponse:
        records = self.storage.list_sessions_for_user(owner_user_id, limit=limit)
        with self._lock:
            loaded_session_ids = {
                session_id
                for session_id, state in self._sessions.items()
                if state.owner_user_id == owner_user_id
            }
        items = [
            UserSessionListItem(
                session_id=str(record["session_id"]),
                created_at=str(record["created_at"]),
                last_seen_at=str(record["last_seen_at"]),
                last_reset_at=(
                    None
                    if record.get("last_reset_at") is None
                    else str(record["last_reset_at"])
                ),
                configuration=SessionConfiguration.model_validate(record["configuration"]),
                phrase_count=int(record["phrase_count"]),
                input_phrase_count=int(record["input_phrase_count"]),
                active_learned_phrase_count=int(record["active_learned_phrase_count"]),
                loaded=str(record["session_id"]) in loaded_session_ids,
            )
            for record in records
        ]
        return UserSessionsResponse(items=items)

    def continue_phrase(
        self,
        request: ContinueRequest,
        owner_user_id: str | None,
    ) -> ContinueResponse:
        state = self._require_session(request.session_id, owner_user_id)
        created_at = utc_now_iso()
        request_id = uuid.uuid4().hex
        should_learn = (
            state.configuration.learn_input
            if request.learn_input is None
            else request.learn_input
        )
        input_phrase, generated_phrase, status_message = state.engine.continue_phrase(
            request.phrase,
            learn_input=should_learn,
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
            learned=should_learn,
            payload=input_phrase.model_dump(mode="json"),
        )
        self.storage.log_phrase(
            phrase_id=uuid.uuid4().hex,
            request_id=request_id,
            session_id=state.session_id,
            kind="generated",
            created_at=created_at,
            learned=False,
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

    def get_history(
        self,
        session_id: str,
        owner_user_id: str | None,
        limit: int = 20,
    ) -> SessionHistoryResponse:
        if not self.storage.session_exists(session_id, owner_user_id, allow_guest=True):
            raise UnknownSessionError(session_id)
        items = [
            HistoryItem.model_validate(item)
            for item in self.storage.get_history(session_id, limit=limit)
        ]
        return SessionHistoryResponse(session_id=session_id, items=items)

    def get_memory(self, session_id: str, owner_user_id: str | None) -> SessionMemoryResponse:
        state = self._require_session(session_id, owner_user_id)
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

    def reset_session(self, session_id: str, owner_user_id: str | None) -> ResetSessionResponse:
        state = self._require_session(session_id, owner_user_id)
        state.engine.reset()
        state.last_seen_at = utc_now_iso()
        self.storage.mark_session_reset(session_id, state.last_seen_at, state.last_seen_at)
        return ResetSessionResponse(
            session_id=session_id,
            reset_at=state.last_seen_at,
            configuration=state.configuration,
        )

    def update_session_settings(
        self,
        session_id: str,
        owner_user_id: str | None,
        request: UpdateSessionSettingsRequest,
    ) -> UpdateSessionSettingsResponse:
        state = self._require_session(session_id, owner_user_id)
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
