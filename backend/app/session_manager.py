from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
import base64
import threading
import uuid

from .graph_renderer import GraphRenderer
from .continuator_adapter import (
    ContinuatorSessionEngine,
    MidiImportError,
    NoContinuationAvailable,
)
from .midi_export import (
    midi_files_to_zip_bytes,
    phrase_payload_to_midi_bytes,
    write_phrase_payload_midi,
)
from .schemas import (
    ContinueRequest,
    ContinueResponse,
    CreateSessionRequest,
    CreateSessionResponse,
    DownloadSessionMidiResponse,
    GeneratePhraseResponse,
    GenerationConstraintsStatus,
    GenerationTraceStep,
    HistoryItem,
    ImportedMidiFileSummary,
    ImportMidiResponse,
    MemoryPhraseItem,
    MidiEvent,
    OpenSessionResponse,
    PhrasePayload,
    ResetSessionResponse,
    SaveSessionMidiResponse,
    SessionConfiguration,
    SessionHistoryResponse,
    SessionMidiDownloadFile,
    SessionMidiExportFile,
    SessionMemoryResponse,
    SessionMemorySummary,
    UpdateSessionNameRequest,
    UpdateSessionNameResponse,
    UpdateSessionPreferencesRequest,
    UpdateSessionPreferencesResponse,
    UpdateSessionSettingsRequest,
    UpdateSessionSettingsResponse,
    UserSessionListItem,
    UserSessionsResponse,
)
from .session_operations import session_operation
from .storage import PhraseStorage


class UnknownSessionError(KeyError):
    """Raised when a session identifier is unknown."""


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def safe_export_path_part(value: object, fallback: str) -> str:
    normalized = "".join(
        char if char.isalnum() or char in {"-", "_"} else "-"
        for char in str(value or "")
    )
    normalized = "-".join(part for part in normalized.split("-") if part)
    return (normalized[:80] or fallback).strip("-_") or fallback


@dataclass
class SessionState:
    session_id: str
    owner_user_id: str | None
    created_at: str
    last_seen_at: str
    configuration: SessionConfiguration
    engine: ContinuatorSessionEngine
    lock: object = field(default_factory=threading.RLock, repr=False)
    continuation_request_count: int = 0
    last_generation_trace: list[GenerationTraceStep] | None = None
    last_generation_constraints: GenerationConstraintsStatus | None = None
    last_generation_request_id: str | None = None
    last_generation_created_at: str | None = None


class SessionManager:
    def __init__(
        self,
        storage: PhraseStorage,
        seed_midi_file: Path | None = None,
        seed_midi_folder: Path | None = None,
        session_export_dir: Path | None = None,
    ) -> None:
        self.storage = storage
        self.seed_midi_file = seed_midi_file
        self.seed_midi_folder = seed_midi_folder
        self.session_export_dir = session_export_dir or Path("session_midi_exports")
        self._sessions: dict[str, SessionState] = {}
        self._session_locks: dict[str, object] = {}
        self._lock = threading.RLock()

    def _session_lock(self, session_id: str):
        with self._lock:
            if session_id not in self._session_locks:
                self._session_locks[session_id] = threading.RLock()
            return self._session_locks[session_id]

    def _persist_memory(self, state: SessionState) -> None:
        self.storage.save_memory(state.session_id, state.engine.get_memory_records())

    @property
    def seeded(self) -> bool:
        return bool(self.seed_midi_file or self.seed_midi_folder)

    def _build_configuration(
        self, request: CreateSessionRequest
    ) -> SessionConfiguration:
        return SessionConfiguration(
            learn_input=request.learn_input,
            transposition=request.transposition,
            forget_past=request.forget_past,
            keep_last_inputs=request.keep_last_inputs,
            markov_order=request.markov_order,
            seeded=self.seeded,
            display_name=None,
            midi_input_id=None,
            midi_input_name=None,
            playback_choice=None,
            playback_choice_name=None,
            midi_copy_output_id=None,
            midi_copy_output_name=None,
        )

    def _build_engine(
        self, configuration: SessionConfiguration, *, load_seed_material: bool = True
    ) -> ContinuatorSessionEngine:
        return ContinuatorSessionEngine(
            learn_input=configuration.learn_input,
            transposition=configuration.transposition,
            forget_past=configuration.forget_past,
            keep_last_inputs=configuration.keep_last_inputs,
            markov_order=configuration.markov_order,
            seed_midi_file=self.seed_midi_file,
            seed_midi_folder=self.seed_midi_folder,
            load_seed_material=load_seed_material,
        )

    @staticmethod
    def _clear_last_generation_graph(state: SessionState) -> None:
        state.last_generation_trace = None
        state.last_generation_constraints = None
        state.last_generation_request_id = None
        state.last_generation_created_at = None

    @staticmethod
    def _remember_last_generation_graph(
        state: SessionState,
        *,
        request_id: str,
        created_at: str,
        constraints: GenerationConstraintsStatus | None,
        generation_trace: list[GenerationTraceStep] | None,
    ) -> None:
        state.last_generation_trace = generation_trace
        state.last_generation_constraints = constraints
        state.last_generation_request_id = request_id
        state.last_generation_created_at = created_at

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
            lock=self._session_lock(session_id),
        )

        with self.storage.transaction():
            self.storage.create_session(
                session_id=session_id,
                user_id=owner_user_id,
                created_at=created_at,
                metadata=configuration.model_dump(),
            )
            self._persist_memory(state)
        with self._lock:
            self._sessions[session_id] = state
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
            None
            if session_record["user_id"] is None
            else str(session_record["user_id"])
        )

        with self._lock:
            loaded_session = self._sessions.get(session_id)
        if loaded_session is not None:
            if not self._can_access_session(loaded_session, owner_user_id):
                raise UnknownSessionError(session_id)
            return loaded_session, 0, False

        configuration = SessionConfiguration.model_validate(session_record["metadata"])
        engine = self._build_engine(
            configuration,
            load_seed_material=not session_record.get("memory_initialized", False),
        )
        if session_record.get("memory_initialized"):
            records = self.storage.load_memory(session_id)
            engine.restore_memory(records)
            restored_phrase_count = len(
                {
                    record["source_phrase_id"]
                    for record in records
                    if not record["is_seed"]
                }
            )
        else:
            # One-time legacy migration. Future restores use exact variants,
            # independent of subsequent changes to transposition/memory settings.
            restored_phrase_count = 0
            for record in self.storage.get_rebuild_phrase_records(session_id):
                payload = PhrasePayload.model_validate(record["payload"])
                phrase_events = [
                    MidiEvent.model_validate(event) for event in payload.events
                ]
                try:
                    engine.learn_phrase_events(
                        phrase_events, source_phrase_id=str(record["id"])
                    )
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
            lock=self._session_lock(session_id),
            continuation_request_count=self.storage.count_continuation_requests(
                session_id,
                last_reset_at=session_record.get("last_reset_at"),
            ),
        )

        with self._lock:
            loaded_session = self._sessions.get(session_id)
            if loaded_session is not None:
                if not self._can_access_session(loaded_session, owner_user_id):
                    raise UnknownSessionError(session_id)
                return loaded_session, 0, False
            self._sessions[session_id] = state

        if not session_record.get("memory_initialized"):
            self._persist_memory(state)
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

    def _require_session(
        self, session_id: str, owner_user_id: str | None
    ) -> SessionState:
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

    def _memory_response(self, state: SessionState) -> SessionMemoryResponse:
        entries = state.engine.get_memory_entries()
        items = [
            MemoryPhraseItem(
                slot=index + 1,
                memory_id=entry.id,
                source="seed" if entry.is_seed else "live",
                phrase_id=entry.source_phrase_id,
                deletable=not entry.is_seed and entry.source_phrase_id is not None,
                event_count=payload.event_count,
                note_count=payload.note_count,
                duration_seconds=payload.duration_seconds,
                payload=payload,
            )
            for index, (entry, payload) in enumerate(entries)
        ]
        seeded_count = sum(entry.is_seed for entry, _ in entries)
        return SessionMemoryResponse(
            session_id=state.session_id,
            configuration=state.configuration,
            summary=SessionMemorySummary(
                active_phrase_count=len(items),
                seeded_phrase_count=seeded_count,
                live_phrase_count=len(items) - seeded_count,
            ),
            items=items,
        )

    @session_operation
    def claim_session(self, session_id: str, owner_user_id: str) -> OpenSessionResponse:
        state = self._require_session(session_id, owner_user_id)
        if not self.storage.claim_session(session_id, owner_user_id):
            raise UnknownSessionError(session_id)
        state.owner_user_id = owner_user_id
        return self.open_session(session_id, owner_user_id)

    @session_operation
    def open_session(self, session_id: str, owner_user_id: str) -> OpenSessionResponse:
        session_record = self.storage.get_session_record(session_id, owner_user_id)
        if session_record is None:
            raise UnknownSessionError(session_id)
        state, restored_phrase_count, restored_from_history = (
            self._restore_session_state(session_record)
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

    def list_user_sessions(
        self, owner_user_id: str, limit: int = 24
    ) -> UserSessionsResponse:
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
                configuration=SessionConfiguration.model_validate(
                    record["configuration"]
                ),
                phrase_count=int(record["phrase_count"]),
                input_phrase_count=int(record["input_phrase_count"]),
                active_learned_phrase_count=int(record["active_learned_phrase_count"]),
                loaded=str(record["session_id"]) in loaded_session_ids,
            )
            for record in records
        ]
        return UserSessionsResponse(items=items)

    @session_operation
    def continue_phrase(
        self,
        request: ContinueRequest,
        owner_user_id: str | None,
    ) -> ContinueResponse:
        state = self._require_session(request.session_id, owner_user_id)
        created_at = utc_now_iso()
        request_id = uuid.uuid4().hex
        source_phrase_id = uuid.uuid4().hex
        should_learn = (
            state.configuration.learn_input
            if request.learn_input is None
            else request.learn_input
        )
        (
            input_phrase,
            generated_phrase,
            constraints,
            generation_trace,
            status_message,
        ) = state.engine.continue_phrase(
            request.phrase,
            learn_input=should_learn,
            continuation_note_count=request.continuation_note_count,
            enforce_end_constraint=request.enforce_end_constraint,
            handoff_viewpoint=request.handoff_viewpoint,
            source_phrase_id=source_phrase_id,
        )

        state.last_seen_at = created_at
        state.continuation_request_count += 1
        self._remember_last_generation_graph(
            state,
            request_id=request_id,
            created_at=created_at,
            constraints=constraints,
            generation_trace=generation_trace,
        )
        self.storage.touch_session(state.session_id, created_at)
        self.storage.log_phrase(
            phrase_id=source_phrase_id,
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

        self._persist_memory(state)

        return ContinueResponse(
            session_id=state.session_id,
            request_id=request_id,
            created_at=created_at,
            input_phrase=input_phrase,
            generated_phrase=generated_phrase,
            constraints=constraints,
            generation_trace=generation_trace,
            status_message=status_message,
        )

    @session_operation
    def generate_phrase(
        self,
        session_id: str,
        owner_user_id: str | None,
        note_count: int | None = None,
        enforce_start_constraint: bool = True,
        enforce_end_constraint: bool = True,
    ) -> GeneratePhraseResponse:
        state = self._require_session(session_id, owner_user_id)
        created_at = utc_now_iso()
        request_id = uuid.uuid4().hex
        (
            generated_phrase,
            constraints,
            generation_trace,
            status_message,
        ) = state.engine.generate_phrase(
            note_count=note_count,
            enforce_start_constraint=enforce_start_constraint,
            enforce_end_constraint=enforce_end_constraint,
        )

        state.last_seen_at = created_at
        self._remember_last_generation_graph(
            state,
            request_id=request_id,
            created_at=created_at,
            constraints=constraints,
            generation_trace=generation_trace,
        )
        self.storage.touch_session(state.session_id, created_at)
        self.storage.log_phrase(
            phrase_id=uuid.uuid4().hex,
            request_id=request_id,
            session_id=state.session_id,
            kind="generated",
            created_at=created_at,
            learned=False,
            payload=generated_phrase.model_dump(mode="json"),
        )

        return GeneratePhraseResponse(
            session_id=state.session_id,
            request_id=request_id,
            created_at=created_at,
            generated_phrase=generated_phrase,
            constraints=constraints,
            generation_trace=generation_trace,
            status_message=status_message,
        )

    @session_operation
    def import_midi_files(
        self,
        session_id: str,
        owner_user_id: str | None,
        midi_files: list[tuple[str, bytes]],
    ) -> ImportMidiResponse:
        state = self._require_session(session_id, owner_user_id)
        if not midi_files:
            raise MidiImportError("Select at least one MIDI file to import.")

        created_at = utc_now_iso()
        request_id = uuid.uuid4().hex
        imported_files, skipped_files = state.engine.import_midi_files(
            midi_files, request_id=request_id
        )

        state.last_seen_at = created_at
        self._clear_last_generation_graph(state)
        self.storage.touch_session(state.session_id, created_at)
        for index, imported_file in enumerate(imported_files):
            self.storage.log_phrase(
                phrase_id=imported_file.source_phrase_id,
                request_id=request_id,
                session_id=state.session_id,
                kind="input",
                created_at=created_at,
                learned=True,
                payload=imported_file.payload.model_dump(mode="json"),
            )

        self._persist_memory(state)
        return ImportMidiResponse(
            session_id=state.session_id,
            created_at=created_at,
            imported_file_count=len(imported_files),
            skipped_file_count=len(skipped_files),
            imported_files=[
                ImportedMidiFileSummary(
                    file_name=imported_file.file_name,
                    event_count=imported_file.payload.event_count,
                    note_count=imported_file.payload.note_count,
                    duration_seconds=imported_file.payload.duration_seconds,
                )
                for imported_file in imported_files
            ],
            skipped_files=skipped_files,
        )

    @session_operation
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

    @session_operation
    def save_session_midi(
        self,
        session_id: str,
        owner_user_id: str | None,
    ) -> SaveSessionMidiResponse:
        if not self.storage.session_exists(session_id, owner_user_id, allow_guest=True):
            raise UnknownSessionError(session_id)

        rows = self.storage.get_played_and_generated_phrases(session_id)
        if not rows:
            raise ValueError(
                "No played or generated phrases are available to save yet."
            )

        exported_at = utc_now_iso()
        folder_name = "-".join(
            [
                safe_export_path_part(session_id[:12], "session"),
                safe_export_path_part(exported_at, "export"),
                uuid.uuid4().hex[:8],
            ]
        )
        export_dir = self.session_export_dir / folder_name
        counts = {"input": 0, "generated": 0}
        files: list[SessionMidiExportFile] = []

        for index, row in enumerate(rows, start=1):
            kind = str(row["kind"])
            if kind not in counts:
                continue
            payload = PhrasePayload.model_validate(row["payload"])
            counts[kind] += 1
            created_at = safe_export_path_part(row["created_at"], "time")
            request_id = safe_export_path_part(row["request_id"], "request")
            file_name = f"{index:04d}_{kind}_{created_at}_{request_id[:12]}.mid"
            path = export_dir / file_name
            write_phrase_payload_midi(payload, path)
            files.append(
                SessionMidiExportFile(
                    kind=kind,
                    request_id=str(row["request_id"]),
                    file_name=file_name,
                    path=str(path.resolve()),
                    event_count=payload.event_count,
                    note_count=payload.note_count,
                    duration_seconds=payload.duration_seconds,
                )
            )

        if not files:
            raise ValueError("No playable phrases are available to save yet.")

        return SaveSessionMidiResponse(
            session_id=session_id,
            exported_at=exported_at,
            directory=str(export_dir.resolve()),
            file_count=len(files),
            input_file_count=counts["input"],
            generated_file_count=counts["generated"],
            files=files,
        )

    @session_operation
    def download_session_midi(
        self,
        session_id: str,
        owner_user_id: str | None,
    ) -> DownloadSessionMidiResponse:
        if not self.storage.session_exists(session_id, owner_user_id, allow_guest=True):
            raise UnknownSessionError(session_id)

        rows = self.storage.get_played_and_generated_phrases(session_id)
        if not rows:
            raise ValueError(
                "No played or generated phrases are available to save yet."
            )

        exported_at = utc_now_iso()
        folder_name = "-".join(
            [
                "continuator-session",
                safe_export_path_part(session_id[:12], "session"),
                safe_export_path_part(exported_at, "export"),
                uuid.uuid4().hex[:8],
            ]
        )
        counts = {"input": 0, "generated": 0}
        files: list[SessionMidiDownloadFile] = []

        for index, row in enumerate(rows, start=1):
            kind = str(row["kind"])
            if kind not in counts:
                continue
            payload = PhrasePayload.model_validate(row["payload"])
            counts[kind] += 1
            created_at = safe_export_path_part(row["created_at"], "time")
            request_id = safe_export_path_part(row["request_id"], "request")
            file_name = f"{index:04d}_{kind}_{created_at}_{request_id[:12]}.mid"
            midi_bytes = phrase_payload_to_midi_bytes(payload)
            files.append(
                SessionMidiDownloadFile(
                    kind=kind,
                    request_id=str(row["request_id"]),
                    file_name=file_name,
                    event_count=payload.event_count,
                    note_count=payload.note_count,
                    duration_seconds=payload.duration_seconds,
                    content_base64=base64.b64encode(midi_bytes).decode("ascii"),
                )
            )

        if not files:
            raise ValueError("No playable phrases are available to save yet.")

        return DownloadSessionMidiResponse(
            session_id=session_id,
            exported_at=exported_at,
            folder_name=folder_name,
            file_count=len(files),
            input_file_count=counts["input"],
            generated_file_count=counts["generated"],
            files=files,
        )

    @session_operation
    def session_midi_zip(
        self,
        session_id: str,
        owner_user_id: str | None,
    ) -> tuple[str, bytes, DownloadSessionMidiResponse]:
        payload = self.download_session_midi(session_id, owner_user_id)
        files = [
            (file.file_name, base64.b64decode(file.content_base64))
            for file in payload.files
        ]
        archive_name = f"{payload.folder_name}.zip"
        return archive_name, midi_files_to_zip_bytes(files), payload

    @session_operation
    def get_memory(
        self, session_id: str, owner_user_id: str | None
    ) -> SessionMemoryResponse:
        state = self._require_session(session_id, owner_user_id)
        return self._memory_response(state)

    @session_operation
    def _graph_data(self, session_id: str, owner_user_id: str | None, *, memory: bool):
        state = self._require_session(session_id, owner_user_id)
        snapshot = state.engine.graph_snapshot(include_counts=memory)
        return snapshot, {
            "trace": state.last_generation_trace,
            "constraints": state.last_generation_constraints,
            "request_id": state.last_generation_request_id,
            "created_at": state.last_generation_created_at,
        }

    def render_memory_graph_svg(
        self,
        session_id: str,
        owner_user_id: str | None,
        *,
        max_nodes: int = 96,
        max_edges: int = 220,
        graph_mode: str = "slice",
        order_filter: int | None = None,
    ) -> str:
        snapshot, data = self._graph_data(session_id, owner_user_id, memory=True)
        # Layout and SVG formatting run after releasing the session lock.
        return GraphRenderer(snapshot).render_graph_svg(
            max_nodes=max_nodes,
            max_edges=max_edges,
            graph_mode=graph_mode,
            order_filter=order_filter,
            focus_symbols=[step.symbol for step in data["trace"]]
            if data["trace"]
            else None,
        )

    def render_constraint_graph_svg(
        self,
        session_id: str,
        owner_user_id: str | None,
        *,
        max_steps: int = 96,
    ) -> str:
        snapshot, data = self._graph_data(session_id, owner_user_id, memory=False)
        return GraphRenderer(snapshot).render_constraint_graph_svg(
            max_steps=max_steps, **data
        )

    @session_operation
    def delete_memory_phrase(
        self,
        session_id: str,
        owner_user_id: str | None,
        slot: int,
        memory_id: str | None = None,
    ) -> SessionMemoryResponse:
        state = self._require_session(session_id, owner_user_id)
        state.engine.delete_memory_slot(slot, expected_id=memory_id)
        self._persist_memory(state)
        self._clear_last_generation_graph(state)
        state.last_seen_at = utc_now_iso()
        self.storage.touch_session(session_id, state.last_seen_at)
        return self._memory_response(state)

    @session_operation
    def reset_session(
        self, session_id: str, owner_user_id: str | None
    ) -> ResetSessionResponse:
        state = self._require_session(session_id, owner_user_id)
        state.engine.reset()
        state.continuation_request_count = 0
        self._clear_last_generation_graph(state)
        state.last_seen_at = utc_now_iso()
        self.storage.mark_session_reset(
            session_id, state.last_seen_at, state.last_seen_at
        )
        self._persist_memory(state)
        return ResetSessionResponse(
            session_id=session_id,
            reset_at=state.last_seen_at,
            configuration=state.configuration,
        )

    @session_operation
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
        self._clear_last_generation_graph(state)
        self.storage.update_session_metadata(
            session_id=session_id,
            metadata=state.configuration.model_dump(),
            last_seen_at=updated_at,
        )
        self._persist_memory(state)
        return UpdateSessionSettingsResponse(
            session_id=session_id,
            updated_at=updated_at,
            configuration=state.configuration,
        )

    @session_operation
    def update_session_name(
        self,
        session_id: str,
        owner_user_id: str,
        request: UpdateSessionNameRequest,
    ) -> UpdateSessionNameResponse:
        state = self._require_session(session_id, owner_user_id)
        if state.owner_user_id != owner_user_id:
            raise UnknownSessionError(session_id)
        updated_at = utc_now_iso()
        display_name = " ".join(request.display_name.split())
        if not display_name:
            display_name = session_id[:8]

        state.configuration = state.configuration.model_copy(
            update={"display_name": display_name}
        )
        state.last_seen_at = updated_at
        self.storage.update_session_metadata(
            session_id=session_id,
            metadata=state.configuration.model_dump(),
            last_seen_at=updated_at,
        )
        return UpdateSessionNameResponse(
            session_id=session_id,
            updated_at=updated_at,
            configuration=state.configuration,
        )

    @session_operation
    def update_session_preferences(
        self,
        session_id: str,
        owner_user_id: str | None,
        request: UpdateSessionPreferencesRequest,
    ) -> UpdateSessionPreferencesResponse:
        state = self._require_session(session_id, owner_user_id)
        updated_at = utc_now_iso()

        def normalize(value: str | None) -> str | None:
            if value is None:
                return None
            normalized = " ".join(value.split())
            return normalized or None

        update_fields = request.model_dump(exclude_unset=True)
        normalized_fields = {
            key: normalize(value) for key, value in update_fields.items()
        }
        state.configuration = state.configuration.model_copy(update=normalized_fields)
        state.last_seen_at = updated_at
        self.storage.update_session_metadata(
            session_id=session_id,
            metadata=state.configuration.model_dump(),
            last_seen_at=updated_at,
        )
        return UpdateSessionPreferencesResponse(
            session_id=session_id,
            updated_at=updated_at,
            configuration=state.configuration,
        )


__all__ = [
    "MidiImportError",
    "NoContinuationAvailable",
    "SessionManager",
    "UnknownSessionError",
]
