from __future__ import annotations

from pathlib import Path
import os
import sys
import threading

import mido

from .schemas import MidiEvent, PhraseNote, PhrasePayload, PlaybackMidiEvent


BACKEND_DIR = Path(__file__).resolve().parents[1]
VENDOR_DIR = BACKEND_DIR / "vendor"


def _bootstrap_continuator_imports() -> None:
    candidate_paths: list[Path] = []
    external_source = os.getenv("CONTINUATOR_SOURCE_DIR")
    if external_source:
        candidate_paths.append(Path(external_source).expanduser())
    candidate_paths.append(VENDOR_DIR)

    for path in candidate_paths:
        if path.exists():
            resolved = str(path)
            if resolved not in sys.path:
                sys.path.insert(0, resolved)
            return

    raise RuntimeError("Could not locate Continuator source files.")


_bootstrap_continuator_imports()

from ctor.continuator import Continuator2  # noqa: E402


class NoContinuationAvailable(RuntimeError):
    """Raised when the engine cannot generate a continuation."""


def _round_float(value: float) -> float:
    return round(float(value), 6)


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
    normalized_notes = _normalize_notes(notes)
    note_payload = [_note_to_schema(note) for note in normalized_notes]
    events = _notes_to_events(normalized_notes)
    duration_seconds = max((note.end_seconds for note in note_payload), default=0.0)

    return PhrasePayload(
        event_count=len(events),
        note_count=len(note_payload),
        duration_seconds=_round_float(duration_seconds),
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
        seed_midi_file: Path | None = None,
        seed_midi_folder: Path | None = None,
    ) -> None:
        self._default_learn_input = learn_input
        self._transposition = transposition
        self._forget_past = forget_past
        self._keep_last_inputs = keep_last_inputs
        self._decay_mode = decay_mode
        self._seed_midi_file = seed_midi_file
        self._seed_midi_folder = seed_midi_folder
        self._seed_sequence_count = 0
        self._lock = threading.RLock()
        self._continuator = self._create_engine()

    def _create_engine(self) -> Continuator2:
        midi_file = str(self._seed_midi_file) if self._seed_midi_file else None
        engine = Continuator2(midi_file=midi_file, transposition=self._transposition)
        if self._seed_midi_folder:
            engine.learn_folder(str(self._seed_midi_folder), transpose=self._transposition)
        engine.set_learn_input(self._default_learn_input)
        engine.set_transpose(self._transposition)
        engine.set_forget(self._forget_past)
        engine.set_keep_last(self._keep_last_inputs)
        engine.set_decay_mode(self._decay_mode)
        self._seed_sequence_count = len(getattr(engine.vom, "input_sequences", []))
        return engine

    def apply_settings(
        self,
        *,
        learn_input: bool | None = None,
        transposition: bool | None = None,
        forget_past: bool | None = None,
        keep_last_inputs: int | None = None,
        decay_mode: str | None = None,
    ) -> None:
        with self._lock:
            if learn_input is not None:
                self._default_learn_input = learn_input
                self._continuator.set_learn_input(learn_input)
            if transposition is not None:
                self._transposition = transposition
                self._continuator.set_transpose(transposition)
            if forget_past is not None:
                self._forget_past = forget_past
                self._continuator.set_forget(forget_past)
            if keep_last_inputs is not None:
                self._keep_last_inputs = keep_last_inputs
                self._continuator.set_keep_last(keep_last_inputs)
            if decay_mode is not None:
                self._decay_mode = decay_mode
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

    def continue_phrase(
        self,
        phrase_events: list[MidiEvent],
        learn_input: bool | None = None,
        continuation_note_count: int | None = None,
    ) -> tuple[PhrasePayload, PhrasePayload, str | None]:
        with self._lock:
            messages = [_event_to_mido_message(event) for event in phrase_events]
            input_phrase = self._continuator.get_phrase_from_mido(messages)
            if not input_phrase:
                raise NoContinuationAvailable("The incoming phrase did not contain any complete notes.")

            should_learn = self._default_learn_input if learn_input is None else learn_input
            input_payload = _build_phrase_payload(input_phrase)
            target_note_count = continuation_note_count or len(input_phrase)

            if should_learn:
                self._continuator.learn_phrase(input_phrase, self._continuator.transpose)

            status_message = None
            constraints = {target_note_count: self._continuator.get_end_vp()}
            generated_sequence = self._continuator.sample_sequence(
                prefix=input_phrase,
                length=target_note_count + 1,
                constraints=constraints,
            )
            if generated_sequence is None:
                generated_sequence = self._continuator.sample_sequence(
                    prefix=input_phrase,
                    length=target_note_count,
                    constraints={},
                )
                status_message = (
                    "Used a same-length continuation without the hard end constraint "
                    "because the exact-ending version had no solution."
                )

            if generated_sequence is None:
                raise NoContinuationAvailable("The Continuator could not find a valid continuation.")

            rendered_vp_sequence = generated_sequence
            if rendered_vp_sequence and rendered_vp_sequence[-1] == self._continuator.get_end_vp():
                rendered_vp_sequence = rendered_vp_sequence[:-1]

            rendered_sequence = self._continuator.realize_vp_sequence(rendered_vp_sequence)
            return input_payload, _build_phrase_payload(rendered_sequence), status_message
