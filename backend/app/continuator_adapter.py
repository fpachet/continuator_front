from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import uuid
from typing import Any

import mido

from ctor.continuator import Continuator2

from .graph_renderer import GraphRenderer, GraphSnapshot
from .phrase_formatting import _viewpoint_label
from .memory import MemoryVariant
from .schemas import (
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


@dataclass(frozen=True)
class ImportedMidiPhrase:
    file_name: str
    payload: PhrasePayload
    source_phrase_id: str


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

    normalized.sort(
        key=lambda note: (float(note.start_time), int(note.pitch), float(note.duration))
    )
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


def _viewpoint_to_schema(
    viewpoint: tuple[int, int, bool, bool] | None,
) -> ViewpointSeed | None:
    if viewpoint is None:
        return None

    pitch, duration_bin, overlaps_left, overlaps_right = viewpoint
    return ViewpointSeed(
        pitch=int(pitch),
        duration_bin=max(0, int(duration_bin)),
        overlaps_left=bool(overlaps_left),
        overlaps_right=bool(overlaps_right),
    )


def _schema_to_viewpoint(
    seed: ViewpointSeed | None,
) -> tuple[int, int, bool, bool] | None:
    if seed is None:
        return None
    return (
        int(seed.pitch),
        max(0, int(seed.duration_bin)),
        bool(seed.overlaps_left),
        bool(seed.overlaps_right),
    )


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
            + max(
                0.0,
                float(last_note.duration)
                + float(getattr(last_note, "next_start_delta", 0.0)),
            ),
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
        markov_order: int = 4,
        seed_midi_file: Path | None = None,
        seed_midi_folder: Path | None = None,
        load_seed_material: bool = True,
    ) -> None:
        self._default_learn_input = learn_input
        self._transposition = transposition
        self._forget_past = forget_past
        self._keep_last_inputs = keep_last_inputs
        self._markov_order = markov_order
        self._seed_midi_file = seed_midi_file
        self._seed_midi_folder = seed_midi_folder
        self._memory_entries: dict[tuple[int, ...], MemoryVariant] = {}
        self._payload_cache: dict[str, PhrasePayload] = {}
        self._lock = threading.RLock()
        self._continuator = self._create_engine(load_seed_material=load_seed_material)
        self._track_memory(is_seed=True)

    def _create_engine(self, *, load_seed_material: bool = True) -> Continuator2:
        midi_file = None
        if load_seed_material and self._seed_midi_file:
            midi_file = str(self._seed_midi_file)

        engine = Continuator2(
            midi_file=midi_file,
            kmax=self._markov_order,
            transposition=self._transposition,
        )
        if load_seed_material and self._seed_midi_folder:
            engine.learn_folder(
                str(self._seed_midi_folder), transpose=self._transposition
            )
        engine.set_learn_input(self._default_learn_input)
        engine.set_transpose(self._transposition)
        engine.set_forget(self._forget_past)
        engine.set_keep_last(self._keep_last_inputs)
        return engine

    def _input_sequences(self) -> list[object]:
        return list(self._continuator.realization_store.input_sequences)

    @staticmethod
    def _sequence_key(sequence) -> tuple[int, ...]:
        # The core copies sequence containers when pruning, retaining the notes.
        return tuple(id(note) for note in sequence)

    def _track_memory(self, *, source_phrase_id=None, is_seed=False) -> None:
        entries = {}
        for sequence in self._input_sequences():
            key = self._sequence_key(sequence)
            entry = self._memory_entries.get(key)
            if entry is None:
                entry = MemoryVariant.from_notes(
                    sequence, source_phrase_id=source_phrase_id, is_seed=is_seed
                )
            entries[key] = entry
        self._memory_entries = entries
        active_ids = {entry.id for entry in entries.values()}
        self._payload_cache = {
            key: value
            for key, value in self._payload_cache.items()
            if key in active_ids
        }

    def _learn_notes(self, notes, transpose, *, source_phrase_id=None):
        self._continuator.learn_phrase(notes, transpose)
        self._track_memory(source_phrase_id=source_phrase_id or uuid.uuid4().hex)

    def get_memory_entries(self) -> list[tuple[MemoryVariant, PhrasePayload]]:
        with self._lock:
            result = []
            for sequence in self._input_sequences():
                entry = self._memory_entries[self._sequence_key(sequence)]
                if entry.id not in self._payload_cache:
                    self._payload_cache[entry.id] = _build_phrase_payload(sequence)
                result.append((entry, self._payload_cache[entry.id]))
            return result

    def get_memory_records(self) -> list[dict[str, object]]:
        with self._lock:
            return [
                self._memory_entries[self._sequence_key(sequence)].record()
                for sequence in self._input_sequences()
            ]

    def restore_memory(self, records: list[dict[str, object]]) -> None:
        with self._lock:
            engine = self._create_engine(load_seed_material=False)
            engine.set_forget(False)
            entries = {}
            try:
                for record in records:
                    entry = MemoryVariant.from_record(record)
                    notes = entry.notes()
                    engine.learn_phrase(notes, False)
                    sequence = engine.realization_store.input_sequences[-1]
                    entries[self._sequence_key(sequence)] = entry
            finally:
                engine.set_forget(self._forget_past)
            self._continuator = engine
            self._memory_entries = entries
            self._payload_cache = {}

    def delete_memory_slot(self, slot: int, *, expected_id: str | None = None) -> None:
        with self._lock:
            records = self.get_memory_records()
            if not 1 <= slot <= len(records):
                raise ValueError(f"Unknown memory slot: {slot}")
            target = records[slot - 1]
            if expected_id is not None and target["id"] != expected_id:
                raise ValueError(
                    "Memory changed; refresh the memory view before deleting."
                )
            if target["is_seed"]:
                raise ValueError(
                    "Seed memory phrases come from configured seed material."
                )
            self.restore_memory(records[: slot - 1] + records[slot:])

    def _has_viewpoint(self, viewpoint: object) -> bool:
        return viewpoint in self._continuator.realization_store.viewpoints_realizations

    def _realize_vp_sequence(
        self,
        vp_sequence: list[object],
        *,
        force_ending_realization: bool = False,
    ) -> list[object]:
        if force_ending_realization and vp_sequence:
            return self._continuator.realize_vp_sequence(
                [*vp_sequence, self._continuator.get_end_vp()]
            )
        return self._continuator.realize_vp_sequence(vp_sequence)

    def _last_generation_trace(self) -> list[GenerationTraceStep] | None:
        trace = self._continuator.get_last_generation_trace()
        if not trace:
            return None
        # The core serializes marker objects with repr(); expose stable labels
        # so graph highlighting and tooltips match the live model's markers.
        markers = {
            repr(self._continuator.get_start_vp()): "START",
            repr(self._continuator.get_end_vp()): "END",
        }

        def normalize(value: Any) -> Any:
            if isinstance(value, str):
                return markers.get(value, value)
            if isinstance(value, list):
                return [normalize(item) for item in value]
            if isinstance(value, dict):
                return {key: normalize(item) for key, item in value.items()}
            return value

        return [GenerationTraceStep.model_validate(normalize(step)) for step in trace]

    def _sample_memory_sequence(
        self,
        *,
        length: int,
        constraints: dict[int, object],
        enforce_start_constraint: bool,
    ) -> list[object] | None:
        if not enforce_start_constraint:
            return self._continuator.sample_sequence(
                prefix=None,
                length=length,
                constraints=constraints,
            )

        return self._continuator.sample_sequence(
            prefix=None,
            start_vp=self._continuator.get_start_vp(),
            length=length,
            constraints=constraints,
        )

    def apply_settings(
        self,
        *,
        learn_input: bool | None = None,
        transposition: bool | None = None,
        forget_past: bool | None = None,
        keep_last_inputs: int | None = None,
        markov_order: int | None = None,
    ) -> None:
        with self._lock:
            rebuild_required = (
                markov_order is not None and markov_order != self._markov_order
            )
            preserved_records = self.get_memory_records() if rebuild_required else []

            if learn_input is not None:
                self._default_learn_input = learn_input
            if transposition is not None:
                self._transposition = transposition
            if forget_past is not None:
                self._forget_past = forget_past
            if keep_last_inputs is not None:
                self._keep_last_inputs = keep_last_inputs
            if markov_order is not None:
                self._markov_order = markov_order

            if rebuild_required:
                self.restore_memory(preserved_records)
                return

            if learn_input is not None:
                self._continuator.set_learn_input(learn_input)
            if transposition is not None:
                self._continuator.set_transpose(transposition)
            if forget_past is not None:
                self._continuator.set_forget(forget_past)
            if keep_last_inputs is not None:
                self._continuator.set_keep_last(keep_last_inputs)

    def reset(self) -> None:
        with self._lock:
            self._continuator = self._create_engine()
            self._memory_entries = {}
            self._payload_cache = {}
            self._track_memory(is_seed=True)

    @staticmethod
    def _extract_order_model_graph_counts(
        model: object,
    ) -> dict[tuple[object, ...], Counter]:
        raw_counts = getattr(model, "counts", {})
        graph_counts: dict[tuple[object, ...], Counter] = {}
        for raw_context, raw_counter in raw_counts.items():
            counter = Counter()
            for symbol, raw_weight in raw_counter.items():
                weight = float(raw_weight)
                if weight > 0:
                    counter[symbol] += weight
            if counter:
                graph_counts[tuple(raw_context)] = counter
        return graph_counts

    def graph_snapshot(self, *, include_counts: bool = True) -> GraphSnapshot:
        with self._lock:
            return GraphSnapshot(
                counts=self._extract_order_model_graph_counts(
                    self._continuator.order_model
                )
                if include_counts
                else {},
                memory_count=len(self._input_sequences()),
                markov_order=self._markov_order,
                start_symbol=self._continuator.get_start_vp(),
                end_symbol=self._continuator.get_end_vp(),
            )

    def render_graph_svg(self, **options) -> str:
        return GraphRenderer(self.graph_snapshot()).render_graph_svg(**options)

    def render_constraint_graph_svg(self, **options) -> str:
        return GraphRenderer(
            self.graph_snapshot(include_counts=False)
        ).render_constraint_graph_svg(**options)

    def get_memory_snapshot(self) -> tuple[list[PhrasePayload], int]:
        with self._lock:
            entries = self.get_memory_entries()
            return [payload for _, payload in entries], sum(
                entry.is_seed for entry, _ in entries
            )

    def _learn_phrase_events_locked(
        self,
        phrase_events: list[MidiEvent],
        *,
        transpose: bool,
        source_phrase_id: str | None = None,
    ) -> PhrasePayload:
        messages = [_event_to_mido_message(event) for event in phrase_events]
        input_phrase = self._continuator.get_phrase_from_mido(messages)
        if not input_phrase:
            raise NoContinuationAvailable(
                "The stored phrase did not contain any complete notes to rebuild."
            )
        self._learn_notes(input_phrase, transpose, source_phrase_id=source_phrase_id)
        return _build_phrase_payload(input_phrase)

    def learn_phrase_events(
        self, phrase_events: list[MidiEvent], *, source_phrase_id: str | None = None
    ) -> PhrasePayload:
        with self._lock:
            return self._learn_phrase_events_locked(
                phrase_events,
                transpose=self._continuator.transpose,
                source_phrase_id=source_phrase_id,
            )

    def import_midi_files(
        self,
        midi_files: list[tuple[str, bytes]],
        *,
        request_id: str | None = None,
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

                    source_phrase_id = (
                        f"{request_id or uuid.uuid4().hex}-import-{index:04d}"
                    )
                    self._learn_notes(
                        notes,
                        self._continuator.transpose,
                        source_phrase_id=source_phrase_id,
                    )
                    imported.append(
                        ImportedMidiPhrase(
                            file_name=file_name,
                            payload=_build_phrase_payload(notes),
                            source_phrase_id=source_phrase_id,
                        )
                    )

            if not imported:
                raise MidiImportError(
                    "No importable MIDI files were found in the selection."
                )

            return imported, skipped

    def generate_phrase(
        self,
        note_count: int | None = None,
        enforce_start_constraint: bool = True,
        enforce_end_constraint: bool = True,
    ) -> tuple[
        PhrasePayload,
        GenerationConstraintsStatus,
        list[GenerationTraceStep] | None,
        str | None,
    ]:
        with self._lock:
            if not self._input_sequences():
                raise NoContinuationAvailable(
                    "The Continuator memory is empty. Load MIDI or learn a phrase first."
                )

            target_note_count = note_count or 12
            status_messages: list[str] = []
            constraints_status = GenerationConstraintsStatus(
                start=GenerationConstraintState(
                    requested=enforce_start_constraint,
                    applied=enforce_start_constraint,
                    value="beginning marker" if enforce_start_constraint else None,
                    reason=(
                        None
                        if enforce_start_constraint
                        else "Start constraint was disabled."
                    ),
                ),
                end=GenerationConstraintState(
                    requested=enforce_end_constraint,
                    applied=enforce_end_constraint,
                    value="ending marker" if enforce_end_constraint else None,
                    reason=None
                    if enforce_end_constraint
                    else "Ending constraint was disabled.",
                ),
            )

            attempts: list[tuple[bool, bool]] = []
            if enforce_start_constraint and enforce_end_constraint:
                attempts = [
                    (True, True),
                    (False, True),
                    (True, False),
                    (False, False),
                ]
            elif enforce_start_constraint:
                attempts = [(True, False), (False, False)]
            elif enforce_end_constraint:
                attempts = [(False, True), (False, False)]
            else:
                attempts = [(False, False)]

            generated_sequence = None
            applied_start_constraint = False
            applied_end_constraint = False
            for attempt_start, attempt_end in attempts:
                constraints = (
                    {target_note_count: self._continuator.get_end_vp()}
                    if attempt_end
                    else {}
                )
                generated_sequence = self._sample_memory_sequence(
                    length=target_note_count + (1 if attempt_end else 0),
                    constraints=constraints,
                    enforce_start_constraint=attempt_start,
                )
                if generated_sequence is None:
                    continue
                applied_start_constraint = attempt_start
                applied_end_constraint = attempt_end
                break

            if generated_sequence is None:
                raise NoContinuationAvailable(
                    "The Continuator could not generate a fresh phrase from the current memory."
                )

            if enforce_start_constraint and not applied_start_constraint:
                constraints_status.start.applied = False
                constraints_status.start.relaxed = True
                constraints_status.start.reason = (
                    "The exact-start version had no solution."
                )
                status_messages.append(
                    "Generated from memory without the hard start constraint "
                    "because the exact-start version had no solution."
                )
            if enforce_end_constraint and not applied_end_constraint:
                constraints_status.end.applied = False
                constraints_status.end.relaxed = True
                constraints_status.end.reason = (
                    "The exact-ending version had no solution."
                )
                status_messages.append(
                    "Generated from memory without the hard end constraint "
                    "because the exact-ending version had no solution."
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
                " ".join(status_messages) or None,
            )

    def continue_phrase(
        self,
        phrase_events: list[MidiEvent],
        learn_input: bool | None = None,
        continuation_note_count: int | None = None,
        enforce_end_constraint: bool = True,
        handoff_viewpoint: ViewpointSeed | None = None,
        source_phrase_id: str | None = None,
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

            should_learn = (
                self._default_learn_input if learn_input is None else learn_input
            )
            input_payload = _build_phrase_payload(input_phrase)
            target_note_count = continuation_note_count or len(input_phrase)

            if should_learn:
                self._learn_notes(
                    input_phrase,
                    self._continuator.transpose,
                    source_phrase_id=source_phrase_id,
                )

            status_messages: list[str] = []
            prefix_for_generation = [
                self._continuator.get_viewpoint(note) for note in input_phrase
            ]
            requested_handoff_viewpoint = _schema_to_viewpoint(handoff_viewpoint)
            if requested_handoff_viewpoint is not None:
                if self._has_viewpoint(requested_handoff_viewpoint):
                    # Serialized playback can lose the last note's overlap
                    # state. Restore that state without discarding the rest
                    # of the played phrase's context.
                    prefix_for_generation[-1] = requested_handoff_viewpoint
                else:
                    status_messages.append(
                        "Ignored the preserved handoff viewpoint because it was outside "
                        "the learned vocabulary; using the played phrase instead."
                    )

            handoff = prefix_for_generation[-1]
            has_prefix = self._has_viewpoint(handoff)
            constraints_status = GenerationConstraintsStatus(
                start=GenerationConstraintState(
                    requested=True,
                    value=_viewpoint_label(handoff),
                ),
                end=GenerationConstraintState(
                    requested=enforce_end_constraint,
                    value="ending marker" if enforce_end_constraint else None,
                    reason=None
                    if enforce_end_constraint
                    else "Ending constraint was disabled.",
                ),
            )

            # The played prefix takes priority over the requested ending.
            # Exhaust its attempts before falling back to an unprompted phrase.
            ending_attempts = [True, False] if enforce_end_constraint else [False]
            attempts = [
                (use_prefix, use_end)
                for use_prefix in ([True, False] if has_prefix else [False])
                for use_end in ending_attempts
            ]
            generated_sequence = None
            for use_prefix, use_end in attempts:
                generated_sequence = self._continuator.sample_sequence(
                    prefix=prefix_for_generation if use_prefix else None,
                    length=target_note_count + int(use_end),
                    constraints=(
                        {target_note_count: self._continuator.get_end_vp()}
                        if use_end
                        else {}
                    ),
                )
                if generated_sequence is not None:
                    constraints_status.start.applied = use_prefix
                    constraints_status.end.applied = use_end
                    break

            if generated_sequence is None:
                raise NoContinuationAvailable(
                    "The Continuator could not find a valid continuation."
                )

            if not constraints_status.start.applied:
                constraints_status.start.relaxed = True
                constraints_status.start.reason = (
                    "The final input viewpoint was outside the learned vocabulary."
                    if not has_prefix
                    else "The played prefix had no continuation of the requested length."
                )
                status_messages.append(
                    "Generated a fresh phrase from memory because "
                    "the played prefix had no valid continuation of the requested length."
                )
            if enforce_end_constraint and not constraints_status.end.applied:
                constraints_status.end.relaxed = True
                constraints_status.end.reason = "No exact-ending continuation of the requested length was available."
                status_messages.append(
                    "Used a same-length continuation without the hard end constraint "
                    "because the exact-ending version had no solution."
                )

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
