from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import random
from tempfile import TemporaryDirectory
import threading
from typing import Any, get_args

import mido

try:
    from ctor.classic import ClassicContinuator
except ImportError:
    from ctor.continuator import Continuator2 as ClassicContinuator

try:
    from ctor.context_bp import ContextBPContinuator
except ImportError:
    ContextBPContinuator = None

from .schemas import (
    EngineKind,
    GenerationConstraintsStatus,
    GenerationConstraintState,
    GenerationTraceStep,
    MidiEvent,
    PhraseNote,
    PhrasePayload,
    PlaybackMidiEvent,
    ViewpointSeed,
)


class NoContinuationAvailable(RuntimeError):
    """Raised when the engine cannot generate a continuation."""


class MidiImportError(RuntimeError):
    """Raised when uploaded MIDI files cannot be imported."""


ENGINE_KINDS: set[str] = set(get_args(EngineKind))


@dataclass(frozen=True)
class ImportedMidiPhrase:
    file_name: str
    payload: PhrasePayload


def _round_float(value: float) -> float:
    return round(float(value), 6)


def _normalize_uploaded_file_name(raw_name: str | None, fallback: str) -> str:
    candidate = (raw_name or fallback).replace("\\", "/")
    parts = [part for part in candidate.split("/") if part and part not in {".", ".."}]
    normalized = "/".join(parts)
    return normalized or fallback


def _normalize_notes(notes: list[object]) -> list[object]:
    normalized = [note.copy() if hasattr(note, "copy") else note for note in notes]
    if not normalized:
        return normalized

    min_start = min(float(note.start_time) for note in normalized)
    if min_start < 0:
        for note in normalized:
            note.start_time = float(note.start_time) - min_start

    normalized.sort(key=lambda note: (float(note.start_time), int(note.pitch), float(note.duration)))
    return normalized


def _note_to_schema(note: object) -> PhraseNote:
    start_seconds = _round_float(note.start_time / 2.0)
    duration_seconds = _round_float(note.duration / 2.0)
    end_seconds = _round_float(start_seconds + duration_seconds)
    return PhraseNote(
        pitch=int(note.pitch),
        velocity=int(note.velocity),
        start_seconds=start_seconds,
        duration_seconds=duration_seconds,
        end_seconds=end_seconds,
        start_beats=_round_float(note.start_time),
        duration_beats=_round_float(note.duration),
    )


def _note_to_viewpoint(note: object) -> tuple[int, int, bool, bool]:
    return (
        int(note.pitch),
        int(float(note.duration)),
        bool(note.overlaps_left()),
        bool(note.overlaps_right()),
    )


def _viewpoint_to_schema(viewpoint: tuple[int, int, bool, bool] | None) -> ViewpointSeed | None:
    if viewpoint is None:
        return None

    pitch, duration_bin, overlaps_left, overlaps_right = viewpoint
    return ViewpointSeed(
        pitch=int(pitch),
        duration_bin=max(0, int(duration_bin)),
        overlaps_left=bool(overlaps_left),
        overlaps_right=bool(overlaps_right),
    )


def _schema_to_viewpoint(seed: ViewpointSeed | None) -> tuple[int, int, bool, bool] | None:
    if seed is None:
        return None
    return (
        int(seed.pitch),
        max(0, int(seed.duration_bin)),
        bool(seed.overlaps_left),
        bool(seed.overlaps_right),
    )


def _pitch_label(pitch: int) -> str:
    names = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
    return f"{names[pitch % 12]}{pitch // 12 - 1}"


def _viewpoint_label(viewpoint: tuple[int, int, bool, bool] | None) -> str | None:
    if viewpoint is None:
        return None
    pitch, duration_bin, overlaps_left, overlaps_right = viewpoint
    overlap_label = ""
    if overlaps_left or overlaps_right:
        sides = []
        if overlaps_left:
            sides.append("left")
        if overlaps_right:
            sides.append("right")
        overlap_label = f", overlaps {'/'.join(sides)}"
    return f"{_pitch_label(int(pitch))}, duration bin {int(duration_bin)}{overlap_label}"


def _notes_to_events(notes: list[object]) -> list[PlaybackMidiEvent]:
    timed_events: list[dict[str, float | int | str]] = []
    for note in notes:
        start_seconds = note.start_time / 2.0
        end_seconds = (note.start_time + note.duration) / 2.0
        timed_events.append(
            {
                "type": "note_on",
                "note": int(note.pitch),
                "velocity": int(note.velocity),
                "channel": 0,
                "time_seconds": start_seconds,
            }
        )
        timed_events.append(
            {
                "type": "note_off",
                "note": int(note.pitch),
                "velocity": 0,
                "channel": 0,
                "time_seconds": end_seconds,
            }
        )

    timed_events.sort(
        key=lambda item: (
            float(item["time_seconds"]),
            0 if item["type"] == "note_off" else 1,
            int(item["note"]),
        )
    )

    events: list[PlaybackMidiEvent] = []
    current_time = 0.0
    for item in timed_events:
        absolute_time = _round_float(float(item["time_seconds"]))
        delta = _round_float(max(0.0, absolute_time - current_time))
        current_time = absolute_time
        events.append(
            PlaybackMidiEvent(
                type=str(item["type"]),
                note=int(item["note"]),
                velocity=int(item["velocity"]),
                channel=int(item["channel"]),
                delta_seconds=delta,
                time_seconds=absolute_time,
            )
        )

    return events


def _build_phrase_payload(notes: list[object]) -> PhrasePayload:
    raw_notes = list(notes)
    normalized_notes = _normalize_notes(notes)
    note_payload = [_note_to_schema(note) for note in normalized_notes]
    events = _notes_to_events(normalized_notes)
    duration_seconds = max((note.end_seconds for note in note_payload), default=0.0)
    handoff_seconds = None
    handoff_viewpoint = None
    if raw_notes:
        last_note = raw_notes[-1]
        next_onset_beats = max(
            0.0,
            float(last_note.start_time)
            + max(0.0, float(last_note.duration) + float(getattr(last_note, "next_start_delta", 0.0))),
        )
        handoff_seconds = _round_float(next_onset_beats / 2.0)
        handoff_viewpoint = _viewpoint_to_schema(_note_to_viewpoint(last_note))

    return PhrasePayload(
        event_count=len(events),
        note_count=len(note_payload),
        duration_seconds=_round_float(duration_seconds),
        handoff_seconds=handoff_seconds,
        handoff_viewpoint=handoff_viewpoint,
        events=events,
        notes=note_payload,
    )


def _event_to_mido_message(event: MidiEvent) -> mido.Message:
    velocity = event.velocity if event.type == "note_on" else 0
    return mido.Message(
        event.type,
        note=event.note,
        velocity=velocity,
        channel=event.channel,
        time=float(event.delta_seconds),
    )


class ContinuatorSessionEngine:
    def __init__(
        self,
        learn_input: bool = True,
        transposition: bool = False,
        forget_past: bool = False,
        keep_last_inputs: int = 20,
        decay_mode: str = "full",
        engine_kind: EngineKind = "classic",
        markov_order: int = 4,
        seed_midi_file: Path | None = None,
        seed_midi_folder: Path | None = None,
    ) -> None:
        if engine_kind not in ENGINE_KINDS:
            raise ValueError(f"Unknown Continuator engine kind: {engine_kind}")
        self._default_learn_input = learn_input
        self._transposition = transposition
        self._forget_past = forget_past
        self._keep_last_inputs = keep_last_inputs
        self._decay_mode = decay_mode
        self._engine_kind = engine_kind
        self._markov_order = markov_order
        self._seed_midi_file = seed_midi_file
        self._seed_midi_folder = seed_midi_folder
        self._seed_sequence_count = 0
        self._lock = threading.RLock()
        self._continuator = self._create_engine()

    def _engine_class(self) -> type[Any]:
        if self._engine_kind == "classic":
            return ClassicContinuator
        if self._engine_kind == "context_bp":
            if ContextBPContinuator is None:
                raise RuntimeError(
                    "ContextBPContinuator is not available. Install a continuator "
                    "package revision that includes ctor.context_bp."
                )
            return ContextBPContinuator
        raise ValueError(f"Unknown Continuator engine kind: {self._engine_kind}")

    def _create_engine(self, *, load_seed_material: bool = True) -> Any:
        midi_file = None
        if load_seed_material and self._seed_midi_file:
            midi_file = str(self._seed_midi_file)

        engine = self._engine_class()(
            midi_file=midi_file,
            kmax=self._markov_order,
            transposition=self._transposition,
        )
        if load_seed_material and self._seed_midi_folder:
            engine.learn_folder(str(self._seed_midi_folder), transpose=self._transposition)
        engine.set_learn_input(self._default_learn_input)
        engine.set_transpose(self._transposition)
        engine.set_forget(self._forget_past)
        engine.set_keep_last(self._keep_last_inputs)
        engine.set_decay_mode(self._decay_mode)
        self._seed_sequence_count = (
            len(getattr(engine.vom, "input_sequences", [])) if load_seed_material else 0
        )
        return engine

    def _is_input_sequence_end_address(self, note_address: object) -> bool:
        try:
            sequence_index, note_index = note_address
            sequences = getattr(self._continuator.vom, "input_sequences", [])
            sequence = sequences[int(sequence_index)]
        except (AttributeError, IndexError, TypeError, ValueError):
            return False
        return bool(sequence) and int(note_index) == len(sequence) - 1

    def _realize_vp_sequence(
        self,
        vp_sequence: list[object],
        *,
        force_ending_realization: bool = False,
    ) -> list[object]:
        if not force_ending_realization or not vp_sequence:
            return self._continuator.realize_vp_sequence(vp_sequence)

        realizations_by_viewpoint = getattr(self._continuator.vom, "viewpoints_realizations", {})
        note_addresses = []
        for index, viewpoint in enumerate(vp_sequence):
            realizations = list(realizations_by_viewpoint.get(viewpoint, []))
            if not realizations:
                return self._continuator.realize_vp_sequence(vp_sequence)

            if index == len(vp_sequence) - 1:
                ending_realizations = [
                    address
                    for address in realizations
                    if self._is_input_sequence_end_address(address)
                ]
                if ending_realizations:
                    note_addresses.append(random.choice(ending_realizations))
                    continue

            note_addresses.append(random.choice(realizations))

        return self._continuator.set_timing(note_addresses)

    def _last_generation_trace(self) -> list[GenerationTraceStep] | None:
        get_trace = getattr(self._continuator, "get_last_generation_trace", None)
        if get_trace is None:
            return None
        trace = get_trace()
        if not trace:
            return None
        return [GenerationTraceStep.model_validate(step) for step in trace]

    def apply_settings(
        self,
        *,
        learn_input: bool | None = None,
        transposition: bool | None = None,
        forget_past: bool | None = None,
        keep_last_inputs: int | None = None,
        decay_mode: str | None = None,
        engine_kind: EngineKind | None = None,
        markov_order: int | None = None,
    ) -> None:
        with self._lock:
            if engine_kind is not None and engine_kind not in ENGINE_KINDS:
                raise ValueError(f"Unknown Continuator engine kind: {engine_kind}")
            rebuild_required = (
                (markov_order is not None and markov_order != self._markov_order)
                or (engine_kind is not None and engine_kind != self._engine_kind)
            )
            preserved_payloads: list[PhrasePayload] = []
            preserved_seed_count = self._seed_sequence_count
            if rebuild_required:
                preserved_payloads, preserved_seed_count = self.get_memory_snapshot()

            if learn_input is not None:
                self._default_learn_input = learn_input
            if transposition is not None:
                self._transposition = transposition
            if forget_past is not None:
                self._forget_past = forget_past
            if keep_last_inputs is not None:
                self._keep_last_inputs = keep_last_inputs
            if decay_mode is not None:
                self._decay_mode = decay_mode
            if engine_kind is not None:
                self._engine_kind = engine_kind
            if markov_order is not None:
                self._markov_order = markov_order

            if rebuild_required:
                self._continuator = self._create_engine(load_seed_material=False)
                for payload in preserved_payloads:
                    phrase_events = [MidiEvent.model_validate(event) for event in payload.events]
                    try:
                        self._learn_phrase_events_locked(phrase_events, transpose=False)
                    except NoContinuationAvailable:
                        continue
                self._seed_sequence_count = min(preserved_seed_count, len(preserved_payloads))
                return

            if learn_input is not None:
                self._continuator.set_learn_input(learn_input)
            if transposition is not None:
                self._continuator.set_transpose(transposition)
            if forget_past is not None:
                self._continuator.set_forget(forget_past)
            if keep_last_inputs is not None:
                self._continuator.set_keep_last(keep_last_inputs)
            if decay_mode is not None:
                self._continuator.set_decay_mode(decay_mode)

    def reset(self) -> None:
        with self._lock:
            self._continuator = self._create_engine()

    def get_memory_snapshot(self) -> tuple[list[PhrasePayload], int]:
        with self._lock:
            sequences = list(getattr(self._continuator.vom, "input_sequences", []))
            payloads = [_build_phrase_payload(sequence) for sequence in sequences]
            seed_count = min(self._seed_sequence_count, len(payloads))
            return payloads, seed_count

    def _learn_phrase_events_locked(
        self,
        phrase_events: list[MidiEvent],
        *,
        transpose: bool,
    ) -> PhrasePayload:
        messages = [_event_to_mido_message(event) for event in phrase_events]
        input_phrase = self._continuator.get_phrase_from_mido(messages)
        if not input_phrase:
            raise NoContinuationAvailable(
                "The stored phrase did not contain any complete notes to rebuild."
            )
        self._continuator.learn_phrase(input_phrase, transpose)
        return _build_phrase_payload(input_phrase)

    def learn_phrase_events(self, phrase_events: list[MidiEvent]) -> PhrasePayload:
        with self._lock:
            return self._learn_phrase_events_locked(
                phrase_events,
                transpose=self._continuator.transpose,
            )

    def import_midi_files(
        self,
        midi_files: list[tuple[str, bytes]],
    ) -> tuple[list[ImportedMidiPhrase], list[str]]:
        with self._lock:
            imported: list[ImportedMidiPhrase] = []
            skipped: list[str] = []
            with TemporaryDirectory(prefix="continuator-midi-import-") as temp_dir:
                temp_root = Path(temp_dir)
                for index, (raw_name, raw_bytes) in enumerate(midi_files):
                    file_name = _normalize_uploaded_file_name(
                        raw_name,
                        f"imported_{index + 1}.mid",
                    )
                    suffix = Path(file_name).suffix.lower()
                    if suffix not in {".mid", ".midi"} or not raw_bytes:
                        skipped.append(file_name)
                        continue

                    temp_path = temp_root / f"upload_{index:04d}{suffix}"
                    temp_path.write_bytes(raw_bytes)
                    try:
                        notes = list(self._continuator.extract_notes(str(temp_path)))
                    except Exception:
                        skipped.append(file_name)
                        continue

                    if not notes:
                        skipped.append(file_name)
                        continue

                    self._continuator.learn_phrase(notes, self._continuator.transpose)
                    imported.append(
                        ImportedMidiPhrase(
                            file_name=file_name,
                            payload=_build_phrase_payload(notes),
                        )
                    )

            if not imported:
                raise MidiImportError("No importable MIDI files were found in the selection.")

            return imported, skipped

    def generate_phrase(
        self,
        note_count: int | None = None,
        enforce_end_constraint: bool = True,
    ) -> tuple[
        PhrasePayload,
        GenerationConstraintsStatus,
        list[GenerationTraceStep] | None,
        str | None,
    ]:
        with self._lock:
            if not getattr(self._continuator.vom, "input_sequences", []):
                raise NoContinuationAvailable(
                    "The Continuator memory is empty. Load MIDI or learn a phrase first."
                )

            target_note_count = note_count or 12
            status_message = None
            constraints_status = GenerationConstraintsStatus(
                start=GenerationConstraintState(
                    requested=False,
                    applied=False,
                    reason="Generated directly from memory.",
                ),
                end=GenerationConstraintState(
                    requested=enforce_end_constraint,
                    applied=enforce_end_constraint,
                    value="ending marker" if enforce_end_constraint else None,
                    reason=None if enforce_end_constraint else "Ending constraint was disabled.",
                ),
            )
            if enforce_end_constraint:
                constraints = {target_note_count: self._continuator.get_end_vp()}
                generated_sequence = self._continuator.sample_sequence(
                    prefix=None,
                    length=target_note_count + 1,
                    constraints=constraints,
                )
                if generated_sequence is None:
                    generated_sequence = self._continuator.sample_sequence(
                        prefix=None,
                        length=target_note_count,
                        constraints={},
                    )
                    status_message = (
                        "Generated from memory without the hard end constraint "
                        "because the exact-ending version had no solution."
                    )
                    constraints_status.end.applied = False
                    constraints_status.end.relaxed = True
                    constraints_status.end.reason = "The exact-ending version had no solution."
            else:
                generated_sequence = self._continuator.sample_sequence(
                    prefix=None,
                    length=target_note_count,
                    constraints={},
                )

            if generated_sequence is None:
                raise NoContinuationAvailable(
                    "The Continuator could not generate a fresh phrase from the current memory."
                )

            rendered_vp_sequence = generated_sequence
            ends_with_end_marker = bool(
                rendered_vp_sequence
                and rendered_vp_sequence[-1] == self._continuator.get_end_vp()
            )
            if ends_with_end_marker:
                rendered_vp_sequence = rendered_vp_sequence[:-1]

            if not rendered_vp_sequence:
                raise NoContinuationAvailable(
                    "The Continuator returned an empty phrase from the current memory."
                )

            rendered_sequence = self._realize_vp_sequence(
                rendered_vp_sequence,
                force_ending_realization=ends_with_end_marker,
            )
            return (
                _build_phrase_payload(rendered_sequence),
                constraints_status,
                self._last_generation_trace(),
                status_message,
            )

    def continue_phrase(
        self,
        phrase_events: list[MidiEvent],
        learn_input: bool | None = None,
        continuation_note_count: int | None = None,
        enforce_end_constraint: bool = True,
        handoff_viewpoint: ViewpointSeed | None = None,
    ) -> tuple[
        PhrasePayload,
        PhrasePayload,
        GenerationConstraintsStatus,
        list[GenerationTraceStep] | None,
        str | None,
    ]:
        with self._lock:
            messages = [_event_to_mido_message(event) for event in phrase_events]
            input_phrase = self._continuator.get_phrase_from_mido(messages)
            if not input_phrase:
                raise NoContinuationAvailable(
                    "The incoming phrase did not contain any complete notes."
                )

            should_learn = self._default_learn_input if learn_input is None else learn_input
            input_payload = _build_phrase_payload(input_phrase)
            target_note_count = continuation_note_count or len(input_phrase)

            if should_learn:
                self._continuator.learn_phrase(input_phrase, self._continuator.transpose)

            status_messages: list[str] = []
            prefix_for_generation = input_phrase
            start_viewpoint = None
            requested_handoff_viewpoint = _schema_to_viewpoint(handoff_viewpoint)
            input_handoff_viewpoint = self._continuator.get_viewpoint(input_phrase[-1])
            displayed_start_viewpoint = requested_handoff_viewpoint or input_handoff_viewpoint
            constraints_status = GenerationConstraintsStatus(
                start=GenerationConstraintState(
                    requested=True,
                    applied=True,
                    value=_viewpoint_label(displayed_start_viewpoint),
                    reason=(
                        "Using preserved handoff viewpoint."
                        if requested_handoff_viewpoint is not None
                        else "Using final input viewpoint."
                    ),
                ),
                end=GenerationConstraintState(
                    requested=enforce_end_constraint,
                    applied=enforce_end_constraint,
                    value="ending marker" if enforce_end_constraint else None,
                    reason=None if enforce_end_constraint else "Ending constraint was disabled.",
                ),
            )
            if requested_handoff_viewpoint is not None:
                if self._continuator.vom.has_viewpoint(requested_handoff_viewpoint):
                    prefix_for_generation = None
                    start_viewpoint = requested_handoff_viewpoint
                else:
                    constraints_status.start.applied = False
                    constraints_status.start.relaxed = True
                    constraints_status.start.reason = (
                        "Preserved handoff viewpoint was outside the learned vocabulary."
                    )
                    status_messages.append(
                        "Ignored the preserved handoff viewpoint because it was outside "
                        "the learned vocabulary."
                    )

            if start_viewpoint is None:
                if not self._continuator.vom.has_viewpoint(input_handoff_viewpoint):
                    prefix_for_generation = None
                    constraints_status.start.applied = False
                    constraints_status.start.relaxed = True
                    constraints_status.start.reason = (
                        "Final input viewpoint was outside the learned vocabulary."
                    )
                    status_messages.append(
                        "Relaxed the continuation handoff because the final input state "
                        "was outside the learned vocabulary."
                    )

            def sample_with_current_start(length: int, constraints: dict[int, object]):
                return self._continuator.sample_sequence(
                    prefix=prefix_for_generation,
                    start_vp=start_viewpoint,
                    length=length,
                    constraints=constraints,
                    relax_prefix_on_fail=False,
                )

            def sample_with_relaxed_start(length: int, constraints: dict[int, object]):
                return self._continuator.sample_sequence(
                    prefix=None,
                    start_vp=None,
                    length=length,
                    constraints=constraints,
                )

            def relax_start_constraint(reason: str) -> None:
                if constraints_status.start.applied:
                    constraints_status.start.applied = False
                    constraints_status.start.relaxed = True
                    constraints_status.start.reason = reason
                    status_messages.append(
                        "Relaxed the continuation handoff because the requested start "
                        "had no valid continuation."
                    )

            if enforce_end_constraint:
                constraints = {target_note_count: self._continuator.get_end_vp()}
                generated_sequence = sample_with_current_start(
                    target_note_count + 1,
                    constraints,
                )
                if generated_sequence is None and constraints_status.start.applied:
                    relax_start_constraint(
                        "The requested handoff had no exact-ending continuation."
                    )
                    generated_sequence = sample_with_relaxed_start(
                        target_note_count + 1,
                        constraints,
                    )
                if generated_sequence is None:
                    generated_sequence = (
                        sample_with_current_start(target_note_count, {})
                        if constraints_status.start.applied
                        else sample_with_relaxed_start(target_note_count, {})
                    )
                    status_messages.append(
                        "Used a same-length continuation without the hard end constraint "
                        "because the exact-ending version had no solution."
                    )
                    constraints_status.end.applied = False
                    constraints_status.end.relaxed = True
                    constraints_status.end.reason = "The exact-ending version had no solution."
                if generated_sequence is None:
                    relax_start_constraint("The requested handoff had no valid continuation.")
                    generated_sequence = sample_with_relaxed_start(target_note_count, {})
            else:
                generated_sequence = sample_with_current_start(target_note_count, {})
                if generated_sequence is None:
                    relax_start_constraint("The requested handoff had no valid continuation.")
                    generated_sequence = sample_with_relaxed_start(target_note_count, {})

            if generated_sequence is None:
                raise NoContinuationAvailable("The Continuator could not find a valid continuation.")

            rendered_vp_sequence = generated_sequence
            ends_with_end_marker = bool(
                rendered_vp_sequence
                and rendered_vp_sequence[-1] == self._continuator.get_end_vp()
            )
            if ends_with_end_marker:
                rendered_vp_sequence = rendered_vp_sequence[:-1]

            rendered_sequence = self._realize_vp_sequence(
                rendered_vp_sequence,
                force_ending_realization=ends_with_end_marker,
            )
            status_message = " ".join(status_messages) or None
            return (
                input_payload,
                _build_phrase_payload(rendered_sequence),
                constraints_status,
                self._last_generation_trace(),
                status_message,
            )
