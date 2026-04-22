from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


DecayMode = Literal["full", "late", "middle", "early"]
MemoryPhraseSource = Literal["seed", "live"]


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


class PhrasePayload(BaseModel):
    event_count: int = Field(ge=0)
    note_count: int = Field(ge=0)
    duration_seconds: float = Field(ge=0.0)
    events: list[PlaybackMidiEvent]
    notes: list[PhraseNote]


class CreateSessionRequest(BaseModel):
    learn_input: bool = True
    transposition: bool = False
    forget_past: bool = False
    keep_last_inputs: int = Field(default=20, ge=1, le=500)
    decay_mode: DecayMode = "full"


class SessionConfiguration(BaseModel):
    learn_input: bool
    transposition: bool
    forget_past: bool
    keep_last_inputs: int = Field(ge=1, le=500)
    decay_mode: DecayMode
    seeded: bool


class CreateSessionResponse(BaseModel):
    session_id: str
    created_at: str
    configuration: SessionConfiguration


class ContinueRequest(BaseModel):
    session_id: str = Field(min_length=1)
    phrase: list[MidiEvent] = Field(min_length=1)
    learn_input: bool | None = None
    continuation_note_count: int | None = Field(default=None, ge=1)


class ContinueResponse(BaseModel):
    session_id: str
    request_id: str
    created_at: str
    input_phrase: PhrasePayload
    generated_phrase: PhrasePayload
    status_message: str | None = None


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


class UpdateSessionSettingsResponse(BaseModel):
    session_id: str
    updated_at: str
    configuration: SessionConfiguration


class PublicConfigResponse(BaseModel):
    app_name: str
    seeded: bool
