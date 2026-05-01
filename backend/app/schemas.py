from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


DecayMode = Literal["full", "late", "middle", "early"]
EngineKind = Literal["classic", "context_bp"]
MemoryPhraseSource = Literal["seed", "live"]
USERNAME_PATTERN = r"^[A-Za-z0-9_.-]{2,32}$"


class MidiEvent(BaseModel):
    type: Literal["note_on", "note_off"]
    note: int = Field(ge=0, le=127)
    velocity: int = Field(ge=0, le=127)
    channel: int = Field(default=0, ge=0, le=15)
    delta_seconds: float = Field(ge=0.0)


class PlaybackMidiEvent(MidiEvent):
    time_seconds: float = Field(ge=0.0)


class PhraseNote(BaseModel):
    pitch: int = Field(ge=0, le=127)
    velocity: int = Field(ge=0, le=127)
    start_seconds: float = Field(ge=0.0)
    duration_seconds: float = Field(ge=0.0)
    end_seconds: float = Field(ge=0.0)
    start_beats: float = Field(ge=0.0)
    duration_beats: float = Field(ge=0.0)


class ViewpointSeed(BaseModel):
    pitch: int = Field(ge=0, le=127)
    duration_bin: int = Field(ge=0)
    overlaps_left: bool
    overlaps_right: bool


class PhrasePayload(BaseModel):
    event_count: int = Field(ge=0)
    note_count: int = Field(ge=0)
    duration_seconds: float = Field(ge=0.0)
    handoff_seconds: float | None = Field(default=None, ge=0.0)
    handoff_viewpoint: ViewpointSeed | None = None
    events: list[PlaybackMidiEvent]
    notes: list[PhraseNote]


class GenerationConstraintState(BaseModel):
    requested: bool = False
    applied: bool = False
    relaxed: bool = False
    value: str | None = None
    reason: str | None = None


class GenerationConstraintsStatus(BaseModel):
    start: GenerationConstraintState
    end: GenerationConstraintState


class GenerationTraceStep(BaseModel):
    position: int = Field(ge=0)
    symbol: Any | None = None
    order: int
    effective_order: int
    context: list[Any] = Field(default_factory=list)
    policy: str | None = None
    candidate_orders: list[int] = Field(default_factory=list)
    candidate_counts: list[int] = Field(default_factory=list)
    skipped_orders: list[int] = Field(default_factory=list)
    skipped_symbol: Any | None = None
    accepted_singleton: bool = False
    suppressed_skipped_symbol: bool = False


class CreateSessionRequest(BaseModel):
    learn_input: bool = True
    transposition: bool = False
    forget_past: bool = False
    keep_last_inputs: int = Field(default=20, ge=1, le=500)
    decay_mode: DecayMode = "full"
    engine_kind: EngineKind = "classic"
    markov_order: int = Field(default=4, ge=1, le=16)


class SessionConfiguration(BaseModel):
    learn_input: bool
    transposition: bool
    forget_past: bool
    keep_last_inputs: int = Field(ge=1, le=500)
    decay_mode: DecayMode
    engine_kind: EngineKind = "classic"
    markov_order: int = Field(default=4, ge=1, le=16)
    seeded: bool
    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    midi_input_id: str | None = Field(default=None, max_length=256)
    midi_input_name: str | None = Field(default=None, max_length=256)
    playback_choice: str | None = Field(default=None, max_length=512)
    playback_choice_name: str | None = Field(default=None, max_length=256)


class CreateSessionResponse(BaseModel):
    session_id: str
    created_at: str
    configuration: SessionConfiguration


class ContinueRequest(BaseModel):
    session_id: str = Field(min_length=1)
    phrase: list[MidiEvent] = Field(min_length=1)
    learn_input: bool | None = None
    continuation_note_count: int | None = Field(default=None, ge=1)
    enforce_end_constraint: bool = True
    handoff_viewpoint: ViewpointSeed | None = None


class ContinueResponse(BaseModel):
    session_id: str
    request_id: str
    created_at: str
    input_phrase: PhrasePayload
    generated_phrase: PhrasePayload
    constraints: GenerationConstraintsStatus | None = None
    generation_trace: list[GenerationTraceStep] | None = None
    status_message: str | None = None


class GeneratePhraseRequest(BaseModel):
    note_count: int | None = Field(default=None, ge=1, le=512)
    enforce_end_constraint: bool = True


class GeneratePhraseResponse(BaseModel):
    session_id: str
    request_id: str
    created_at: str
    generated_phrase: PhrasePayload
    constraints: GenerationConstraintsStatus | None = None
    generation_trace: list[GenerationTraceStep] | None = None
    status_message: str | None = None


class ImportedMidiFileSummary(BaseModel):
    file_name: str = Field(min_length=1)
    event_count: int = Field(ge=0)
    note_count: int = Field(ge=0)
    duration_seconds: float = Field(ge=0.0)


class ImportMidiResponse(BaseModel):
    session_id: str
    created_at: str
    imported_file_count: int = Field(ge=0)
    skipped_file_count: int = Field(ge=0)
    imported_files: list[ImportedMidiFileSummary]
    skipped_files: list[str] = Field(default_factory=list)


class HistoryItem(BaseModel):
    id: str
    request_id: str
    kind: Literal["input", "generated"]
    created_at: str
    event_count: int = Field(ge=0)
    note_count: int = Field(ge=0)
    duration_seconds: float = Field(ge=0.0)
    payload: PhrasePayload


class SessionHistoryResponse(BaseModel):
    session_id: str
    items: list[HistoryItem]


class MemoryPhraseItem(BaseModel):
    slot: int = Field(ge=1)
    source: MemoryPhraseSource
    event_count: int = Field(ge=0)
    note_count: int = Field(ge=0)
    duration_seconds: float = Field(ge=0.0)
    payload: PhrasePayload


class SessionMemorySummary(BaseModel):
    active_phrase_count: int = Field(ge=0)
    seeded_phrase_count: int = Field(ge=0)
    live_phrase_count: int = Field(ge=0)


class SessionMemoryResponse(BaseModel):
    session_id: str
    configuration: SessionConfiguration
    summary: SessionMemorySummary
    items: list[MemoryPhraseItem]


class ResetSessionResponse(BaseModel):
    session_id: str
    reset_at: str
    configuration: SessionConfiguration


class UpdateSessionSettingsRequest(BaseModel):
    learn_input: bool | None = None
    transposition: bool | None = None
    forget_past: bool | None = None
    keep_last_inputs: int | None = Field(default=None, ge=1, le=500)
    decay_mode: DecayMode | None = None
    engine_kind: EngineKind | None = None
    markov_order: int | None = Field(default=None, ge=1, le=16)


class UpdateSessionSettingsResponse(BaseModel):
    session_id: str
    updated_at: str
    configuration: SessionConfiguration


class UpdateSessionNameRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=80)


class UpdateSessionNameResponse(BaseModel):
    session_id: str
    updated_at: str
    configuration: SessionConfiguration


class UpdateSessionPreferencesRequest(BaseModel):
    midi_input_id: str | None = Field(default=None, max_length=256)
    midi_input_name: str | None = Field(default=None, max_length=256)
    playback_choice: str | None = Field(default=None, max_length=512)
    playback_choice_name: str | None = Field(default=None, max_length=256)


class UpdateSessionPreferencesResponse(BaseModel):
    session_id: str
    updated_at: str
    configuration: SessionConfiguration


class PublicConfigResponse(BaseModel):
    app_name: str
    seeded: bool
    continuator_version: str | None = None
    continuator_package_version: str | None = None
    continuator_commit: str | None = None
    continuator_source_url: str | None = None


class AuthUser(BaseModel):
    id: str
    username: str
    created_at: str


class AuthStatusResponse(BaseModel):
    user: AuthUser | None = None


class RegisterRequest(BaseModel):
    username: str = Field(min_length=2, max_length=32, pattern=USERNAME_PATTERN)
    password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    username: str = Field(min_length=2, max_length=32, pattern=USERNAME_PATTERN)
    password: str = Field(min_length=8, max_length=128)


class LogoutResponse(BaseModel):
    ok: bool = True


class UserSessionListItem(BaseModel):
    session_id: str
    created_at: str
    last_seen_at: str
    last_reset_at: str | None = None
    configuration: SessionConfiguration
    phrase_count: int = Field(ge=0)
    input_phrase_count: int = Field(ge=0)
    active_learned_phrase_count: int = Field(ge=0)
    loaded: bool = False


class UserSessionsResponse(BaseModel):
    items: list[UserSessionListItem]


class OpenSessionResponse(BaseModel):
    session_id: str
    created_at: str
    last_seen_at: str
    configuration: SessionConfiguration
    restored_phrase_count: int = Field(ge=0)
    restored_from_history: bool
