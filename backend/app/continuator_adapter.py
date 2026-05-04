from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from html import escape
from pathlib import Path
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

try:
    from ctor.vo_regular_bp import VORegularBPContinuator
except ImportError:
    VORegularBPContinuator = None

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
GRAPH_SELECTION_MODES = {"slice", "all", "most_used", "neighborhood"}


@dataclass(frozen=True)
class ImportedMidiPhrase:
    file_name: str
    payload: PhrasePayload


@dataclass(frozen=True)
class _GraphEdge:
    source: tuple[object, ...]
    target: tuple[object, ...]
    symbol: object
    weight: float


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


def _svg_text_lines(
    lines: list[str],
    *,
    x: float,
    y: float,
    class_name: str,
    anchor: str = "start",
    line_height: int = 14,
) -> str:
    if not lines:
        return ""
    escaped_lines = [escape(line) for line in lines]
    tspans = [
        f'<tspan x="{x:.1f}" dy="{0 if index == 0 else line_height}">{line}</tspan>'
        for index, line in enumerate(escaped_lines)
    ]
    return (
        f'<text class="{class_name}" x="{x:.1f}" y="{y:.1f}" '
        f'text-anchor="{anchor}">{"".join(tspans)}</text>'
    )


def _format_graph_weight(weight: float) -> str:
    if abs(weight - round(weight)) < 0.001:
        return str(int(round(weight)))
    return f"{weight:.2f}".rstrip("0").rstrip(".")


def _constraint_state_label(state: GenerationConstraintState | None) -> str:
    if state is None:
        return "not requested"
    if state.applied:
        return "applied"
    if state.relaxed:
        return "relaxed"
    if state.requested:
        return "requested"
    return "disabled"


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
        if self._engine_kind == "vo_regular_bp":
            if VORegularBPContinuator is None:
                raise RuntimeError(
                    "VORegularBPContinuator is not available. Install a continuator "
                    "package revision that includes ctor.vo_regular_bp and vo_regular_bp."
                )
            return VORegularBPContinuator
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
        set_decay_mode = getattr(engine, "set_decay_mode", None)
        if callable(set_decay_mode):
            set_decay_mode(self._decay_mode)
        midi_store = self._engine_midi_store(engine)
        self._seed_sequence_count = (
            len(getattr(midi_store, "input_sequences", [])) if load_seed_material else 0
        )
        return engine

    @staticmethod
    def _engine_midi_store(engine: object) -> object | None:
        store_for_engine = getattr(engine, "_midi_store", None)
        if callable(store_for_engine):
            try:
                return store_for_engine()
            except AttributeError:
                pass
        store = getattr(engine, "realization_store", None)
        if store is not None:
            return store
        return getattr(engine, "vom", None)

    def _midi_store(self) -> object | None:
        return self._engine_midi_store(self._continuator)

    def _input_sequences(self) -> list[object]:
        store = self._midi_store()
        if store is None:
            return []
        return list(getattr(store, "input_sequences", []))

    def _has_viewpoint(self, viewpoint: object) -> bool:
        store = self._midi_store()
        if store is None:
            return False
        has_viewpoint = getattr(store, "has_viewpoint", None)
        if callable(has_viewpoint):
            return bool(has_viewpoint(viewpoint))
        return viewpoint in getattr(store, "viewpoints_realizations", {})

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
        get_trace = getattr(self._continuator, "get_last_generation_trace", None)
        if get_trace is None:
            return None
        trace = get_trace()
        if not trace:
            return None
        return [GenerationTraceStep.model_validate(step) for step in trace]

    def _trace_value(self, value: object) -> object:
        if self._is_start_symbol(value):
            return "START"
        if self._is_end_symbol(value):
            return "END"
        if value is None or isinstance(value, (bool, int, float, str)):
            return value
        if hasattr(value, "item"):
            try:
                scalar_value = value.item()
            except ValueError:
                scalar_value = None
            if isinstance(scalar_value, (bool, int, float, str)):
                return scalar_value
        if isinstance(value, tuple):
            return [self._trace_value(item) for item in value]
        if isinstance(value, list):
            return [self._trace_value(item) for item in value]
        return repr(value)

    def _synthetic_generation_trace(
        self,
        sequence: list[object] | None,
        *,
        initial_context: list[object] | None = None,
    ) -> list[GenerationTraceStep] | None:
        if not sequence:
            return None

        graph_counts, _model_label = self._graph_counts()
        raw_context = list(initial_context or [])
        kmax = max(1, int(self._markov_order))
        trace: list[GenerationTraceStep] = []
        for position, symbol in enumerate(sequence):
            effective_order = min(kmax, len(raw_context))
            candidate_orders: list[int] = []
            candidate_counts: list[int] = []
            chosen_order = 0
            for order in range(effective_order, 0, -1):
                candidate_context = tuple(raw_context[-order:])
                continuations = graph_counts.get(candidate_context)
                if not continuations:
                    continue
                candidate_orders.append(order)
                candidate_counts.append(len(continuations))
                if not chosen_order and symbol in continuations:
                    chosen_order = order

            if not chosen_order and candidate_orders:
                chosen_order = candidate_orders[0]

            context = raw_context[-effective_order:] if effective_order else []
            trace.append(
                GenerationTraceStep(
                    position=position,
                    symbol=self._trace_value(symbol),
                    order=chosen_order,
                    effective_order=effective_order,
                    context=[self._trace_value(value) for value in context],
                    policy="generated path",
                    candidate_orders=candidate_orders,
                    candidate_counts=candidate_counts,
                )
            )
            raw_context.append(symbol)

        return trace

    def _generation_trace_or_path(
        self,
        sequence: list[object] | None,
        *,
        initial_context: list[object] | None = None,
    ) -> list[GenerationTraceStep] | None:
        return self._last_generation_trace() or self._synthetic_generation_trace(
            sequence,
            initial_context=initial_context,
        )

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

        if self._engine_kind == "context_bp":
            return self._continuator.sample_sequence(
                prefix=[],
                length=length,
                constraints=constraints,
            )

        return self._continuator.sample_sequence(
            prefix=None,
            start_vp=self._continuator.get_start_vp(),
            length=length,
            constraints=constraints,
            relax_prefix_on_fail=False,
            relax_pos0_on_fail=False,
        )

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
                set_decay_mode = getattr(self._continuator, "set_decay_mode", None)
                if callable(set_decay_mode):
                    set_decay_mode(decay_mode)

    def reset(self) -> None:
        with self._lock:
            self._continuator = self._create_engine()

    def _is_start_symbol(self, symbol: object) -> bool:
        try:
            start_symbol = self._continuator.get_start_vp()
        except Exception:
            return False
        if symbol is start_symbol:
            return True
        try:
            return bool(symbol == start_symbol)
        except Exception:
            return False

    def _is_end_symbol(self, symbol: object) -> bool:
        try:
            end_symbol = self._continuator.get_end_vp()
        except Exception:
            return False
        if symbol is end_symbol:
            return True
        try:
            return bool(symbol == end_symbol)
        except Exception:
            return False

    def _graph_symbol_key(self, symbol: object) -> str:
        if self._is_start_symbol(symbol):
            return "__start__"
        if self._is_end_symbol(symbol):
            return "__end__"
        if isinstance(symbol, str):
            normalized = symbol.strip()
            if normalized in {"START", "<START>"}:
                return "__start__"
            if normalized in {"END", "<END>"}:
                return "__end__"
        return f"{type(symbol).__module__}.{type(symbol).__qualname__}:{repr(symbol)}"

    def _graph_context_key(self, context: tuple[object, ...]) -> str:
        return "|".join(self._graph_symbol_key(symbol) for symbol in context)

    def _graph_symbol_label(self, symbol: object) -> str:
        if self._is_start_symbol(symbol):
            return "START"
        if self._is_end_symbol(symbol):
            return "END"
        if isinstance(symbol, str):
            normalized = symbol.strip()
            if normalized in {"START", "<START>"}:
                return "START"
            if normalized in {"END", "<END>"}:
                return "END"
            return normalized
        if isinstance(symbol, tuple) and len(symbol) == 4:
            try:
                pitch = int(symbol[0])
                duration_bin = int(symbol[1])
                overlaps_left = bool(symbol[2])
                overlaps_right = bool(symbol[3])
                suffixes = []
                if duration_bin:
                    suffixes.append(f"d{duration_bin}")
                if overlaps_left:
                    suffixes.append("L")
                if overlaps_right:
                    suffixes.append("R")
                suffix = f" {'/'.join(suffixes)}" if suffixes else ""
                return f"{_pitch_label(pitch)}{suffix}"
            except (TypeError, ValueError):
                pass
        if hasattr(symbol, "item"):
            try:
                scalar_value = symbol.item()
            except ValueError:
                scalar_value = None
            if isinstance(scalar_value, (bool, int, float, str)):
                return str(scalar_value)
        raw_label = repr(symbol)
        if raw_label.startswith("<") and raw_label.endswith(">"):
            return raw_label[1:-1].upper()
        return raw_label

    def _trace_symbol_label(self, symbol: object) -> str:
        if symbol is None:
            return "none"
        if isinstance(symbol, list):
            symbol = tuple(symbol)
        return self._graph_symbol_label(symbol)

    def _graph_context_label_lines(self, context: tuple[object, ...]) -> list[str]:
        if not context:
            return ["empty"]
        symbol_labels = [self._graph_symbol_label(symbol) for symbol in context]
        if len(symbol_labels) == 1:
            return [self._truncate_graph_label(symbol_labels[0], 24)]
        visible_labels = symbol_labels[-5:]
        prefix = "... " if len(symbol_labels) > len(visible_labels) else ""
        if len(visible_labels) == 2:
            label = f"{prefix}{visible_labels[0]} -> {visible_labels[1]}"
        else:
            label = f"{prefix}{' '.join(visible_labels[:-1])} -> {visible_labels[-1]}"
        return [self._truncate_graph_label(label, 30)]

    @staticmethod
    def _truncate_graph_label(label: str, limit: int) -> str:
        compact = " ".join(str(label).split())
        if len(compact) <= limit:
            return compact
        return f"{compact[: max(1, limit - 3)]}..."

    def _wrap_graph_label(self, label: str, *, limit: int, max_lines: int) -> list[str]:
        words = " ".join(str(label).split()).split(" ")
        lines: list[str] = []
        current = ""
        for word in words:
            candidate = word if not current else f"{current} {word}"
            if len(candidate) <= limit:
                current = candidate
                continue
            if current:
                lines.append(current)
            current = word
            if len(lines) >= max_lines - 1:
                break
        if current and len(lines) < max_lines:
            lines.append(current)
        if len(lines) == max_lines and " ".join(words) != " ".join(lines):
            lines[-1] = self._truncate_graph_label(lines[-1], limit)
        return [self._truncate_graph_label(line, limit) for line in lines] or [
            self._truncate_graph_label(label, limit)
        ]

    def _extract_classic_graph_counts(self, store: object) -> dict[tuple[object, ...], Counter]:
        raw_contexts = getattr(store, "ctx_to_continuations", {})
        unique_viewpoints = list(getattr(store, "all_unique_viewpoints", []))
        now = getattr(store, "global_step", 0)
        if getattr(store, "decay_freeze_at", None) is not None:
            now = getattr(store, "decay_freeze_at")

        graph_counts: dict[tuple[object, ...], Counter] = {}
        for raw_context, multi_counter in raw_contexts.items():
            weights = {}
            counter_weights = getattr(multi_counter, "weights", None)
            if callable(counter_weights):
                weights = counter_weights(now, self._decay_mode)
            elif hasattr(multi_counter, "full"):
                weights = getattr(multi_counter, "full")
            edge_counts = Counter()
            for raw_index, raw_weight in weights.items():
                try:
                    symbol = unique_viewpoints[int(raw_index)]
                    weight = float(raw_weight)
                except (IndexError, TypeError, ValueError):
                    continue
                if weight > 0:
                    edge_counts[symbol] += weight
            if edge_counts:
                graph_counts[tuple(raw_context)] = edge_counts
        return graph_counts

    @staticmethod
    def _extract_context_bp_graph_counts(model: object) -> dict[tuple[object, ...], Counter]:
        vocabulary = getattr(model, "vocabulary", None)
        raw_counts = getattr(getattr(model, "counts", None), "counts", {})
        if vocabulary is None:
            return {}
        decode = getattr(vocabulary, "decode", None)
        if not callable(decode):
            return {}

        graph_counts: dict[tuple[object, ...], Counter] = {}
        for raw_context, raw_counter in raw_counts.items():
            context = tuple(decode(symbol_id) for symbol_id in raw_context)
            counter = Counter()
            for raw_symbol, raw_weight in raw_counter.items():
                weight = float(raw_weight)
                if weight > 0:
                    counter[decode(raw_symbol)] += weight
            if counter:
                graph_counts[context] = counter
        return graph_counts

    @staticmethod
    def _extract_order_model_graph_counts(model: object) -> dict[tuple[object, ...], Counter]:
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

    def _graph_counts(self) -> tuple[dict[tuple[object, ...], Counter], str]:
        store = self._midi_store()
        if store is not None and hasattr(store, "ctx_to_continuations"):
            return self._extract_classic_graph_counts(store), "Classic variable-order model"

        context_model = getattr(self._continuator, "context_model", None)
        if context_model is not None:
            return self._extract_context_bp_graph_counts(context_model), "Context BP model"

        order_model = getattr(self._continuator, "order_model", None)
        if order_model is not None:
            return self._extract_order_model_graph_counts(order_model), "VO regular BP order model"

        return {}, "Unknown model"

    def _graph_focus_symbol_keys(
        self,
        focus_symbols: list[object] | None,
    ) -> set[str]:
        keys: set[str] = set()
        for symbol in focus_symbols or []:
            if isinstance(symbol, list):
                symbol = tuple(symbol)
            keys.add(self._graph_symbol_key(symbol))
        return keys

    def _graph_context_has_focus(
        self,
        context: tuple[object, ...],
        focus_symbol_keys: set[str],
    ) -> bool:
        if not focus_symbol_keys:
            return False
        return any(self._graph_symbol_key(symbol) in focus_symbol_keys for symbol in context)

    @staticmethod
    def _successor_context(
        context: tuple[object, ...],
        symbol: object,
        all_contexts: set[tuple[object, ...]],
        kmax: int,
    ) -> tuple[object, ...]:
        tokens = (*context, symbol)
        for order in range(min(kmax, len(tokens)), 0, -1):
            candidate = tuple(tokens[-order:])
            if candidate in all_contexts:
                return candidate
        return (symbol,)

    def render_graph_svg(
        self,
        *,
        max_nodes: int = 96,
        max_edges: int = 220,
        graph_mode: str = "slice",
        order_filter: int | None = None,
        focus_symbols: list[object] | None = None,
    ) -> str:
        with self._lock:
            graph_counts, model_label = self._graph_counts()
            memory_count = len(self._input_sequences())
            kmax = max(1, int(self._markov_order))
            max_nodes = max(8, min(240, int(max_nodes)))
            max_edges = max(1, min(600, int(max_edges)))
            graph_mode = graph_mode if graph_mode in GRAPH_SELECTION_MODES else "slice"
            if order_filter is not None:
                order_filter = max(1, min(kmax, int(order_filter)))
                graph_counts = {
                    context: counter
                    for context, counter in graph_counts.items()
                    if len(context) == order_filter
                }

            edges: list[_GraphEdge] = []
            all_contexts = set(graph_counts)
            for context, continuations in graph_counts.items():
                for symbol, weight in continuations.items():
                    if weight <= 0:
                        continue
                    target = self._successor_context(context, symbol, all_contexts, kmax)
                    edges.append(
                        _GraphEdge(
                            source=context,
                            target=target,
                            symbol=symbol,
                            weight=float(weight),
                        )
                    )

            return self._render_graph_svg(
                model_label=model_label,
                graph_counts=graph_counts,
                edges=edges,
                memory_count=memory_count,
                max_nodes=max_nodes,
                max_edges=max_edges,
                graph_mode=graph_mode,
                order_filter=order_filter,
                focus_symbols=focus_symbols,
            )

    def _render_graph_svg(
        self,
        *,
        model_label: str,
        graph_counts: dict[tuple[object, ...], Counter],
        edges: list[_GraphEdge],
        memory_count: int,
        max_nodes: int,
        max_edges: int,
        graph_mode: str,
        order_filter: int | None,
        focus_symbols: list[object] | None,
    ) -> str:
        context_counts = defaultdict(int)
        for context in graph_counts:
            context_counts[len(context)] += 1

        total_contexts = len(graph_counts)
        total_edges = len(edges)
        selected_nodes: dict[str, tuple[object, ...]] = {}
        selected_edges: list[_GraphEdge] = []
        sorted_contexts = sorted(
            graph_counts,
            key=lambda candidate: (
                len(candidate),
                self._graph_context_key(candidate),
            ),
        )

        def add_node(context: tuple[object, ...]) -> bool:
            key = self._graph_context_key(context)
            if key in selected_nodes:
                return True
            if len(selected_nodes) >= max_nodes:
                return False
            selected_nodes[key] = context
            return True

        def add_edge(edge: _GraphEdge) -> bool:
            if len(selected_edges) >= max_edges:
                return False
            source_key = self._graph_context_key(edge.source)
            target_key = self._graph_context_key(edge.target)
            needed = int(source_key not in selected_nodes) + int(target_key not in selected_nodes)
            if len(selected_nodes) + needed > max_nodes:
                return False
            add_node(edge.source)
            add_node(edge.target)
            selected_edges.append(edge)
            return True

        default_edge_key = lambda edge: (
            0 if len(edge.source) == 1 else 1,
            -edge.weight,
            len(edge.source),
            self._graph_context_key(edge.source),
            self._graph_context_key(edge.target),
        )

        if graph_mode == "all":
            for context in sorted_contexts:
                if not add_node(context):
                    break
            for edge in sorted(edges, key=default_edge_key):
                if len(selected_edges) >= max_edges:
                    break
                if (
                    self._graph_context_key(edge.source) in selected_nodes
                    and self._graph_context_key(edge.target) in selected_nodes
                ):
                    selected_edges.append(edge)
        elif graph_mode == "most_used":
            for edge in sorted(
                edges,
                key=lambda edge: (
                    -edge.weight,
                    len(edge.source),
                    self._graph_context_key(edge.source),
                    self._graph_context_key(edge.target),
                ),
            ):
                add_edge(edge)
        elif graph_mode == "neighborhood":
            focus_symbol_keys = self._graph_focus_symbol_keys(focus_symbols)
            if focus_symbol_keys:
                focused_contexts = [
                    context
                    for context in sorted_contexts
                    if self._graph_context_has_focus(context, focus_symbol_keys)
                ]
                for context in focused_contexts:
                    add_node(context)
                for edge in sorted(
                    edges,
                    key=lambda edge: (
                        -int(self._graph_context_has_focus(edge.source, focus_symbol_keys)),
                        -int(self._graph_context_has_focus(edge.target, focus_symbol_keys)),
                        -edge.weight,
                        len(edge.source),
                        self._graph_context_key(edge.source),
                        self._graph_context_key(edge.target),
                    ),
                ):
                    source_focused = self._graph_context_has_focus(edge.source, focus_symbol_keys)
                    target_focused = self._graph_context_has_focus(edge.target, focus_symbol_keys)
                    if source_focused or target_focused:
                        add_edge(edge)

        if not selected_nodes:
            graph_mode = "slice"

        if graph_mode == "slice":
            for context in sorted_contexts:
                if len(context) > 1:
                    break
                if not add_node(context):
                    break

            for edge in sorted(edges, key=default_edge_key):
                if len(selected_edges) >= max_edges:
                    break
                add_edge(edge)

        width = 1080
        if not selected_nodes:
            height = 520
            return self._render_empty_graph_svg(
                width=width,
                height=height,
                model_label=model_label,
                memory_count=memory_count,
            )

        nodes_by_order: dict[int, list[tuple[object, ...]]] = defaultdict(list)
        for context in selected_nodes.values():
            nodes_by_order[len(context)].append(context)
        for contexts in nodes_by_order.values():
            contexts.sort(key=lambda context: self._graph_context_key(context))

        orders = sorted(nodes_by_order)
        left_margin = 54
        top_margin = 120
        node_width = 106
        node_height = 20
        column_gap = max(110, (width - left_margin * 2 - node_width) / max(1, len(orders) - 1))
        row_gap = 7
        max_column_size = max(len(contexts) for contexts in nodes_by_order.values())
        height = max(560, top_margin + max_column_size * (node_height + row_gap) + 84)

        node_positions: dict[str, tuple[float, float]] = {}
        for column_index, order in enumerate(orders):
            contexts = nodes_by_order[order]
            column_x = left_margin + column_index * column_gap
            used_height = len(contexts) * node_height + max(0, len(contexts) - 1) * row_gap
            start_y = top_margin + max(0, (height - top_margin - 86 - used_height) / 2)
            for row_index, context in enumerate(contexts):
                node_positions[self._graph_context_key(context)] = (
                    column_x,
                    start_y + row_index * (node_height + row_gap),
                )

        max_weight = max((edge.weight for edge in selected_edges), default=1.0)
        svg_parts = [
            '<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="0 0 {width} {height}" width="{width}" height="{height}" '
            'role="img" aria-labelledby="title desc">',
            "<title id=\"title\">Continuator internal context graph</title>",
            (
                "<desc id=\"desc\">A static graph snapshot of learned Continuator "
                "contexts and continuations.</desc>"
            ),
            "<style>",
            "svg{background:#071217;color:#ecf4ef;font-family:Avenir Next,Segoe UI,Trebuchet MS,sans-serif}",
            ".title{fill:#ecf4ef;font-size:28px;font-weight:750}",
            ".meta{fill:#9bb8b1;font-size:13px}",
            ".order{fill:#6dd3ce;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}",
            ".node{stroke-width:.9;filter:url(#shadow)}",
            ".node-label{fill:#ecf4ef;font-size:5px;font-weight:700}",
            ".edge{fill:none;stroke:#6dd3ce;stroke-opacity:.38}",
            ".edge-label{fill:#f7d3b9;font-size:5px;font-weight:800}",
            ".footer{fill:#9bb8b1;font-size:12px}",
            "</style>",
            "<defs>",
            (
                '<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">'
                '<feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="#000" flood-opacity=".28"/>'
                "</filter>"
            ),
            (
                '<marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" '
                'markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
                '<path d="M 0 0 L 10 5 L 0 10 z" fill="#6dd3ce" fill-opacity=".72"/>'
                "</marker>"
            ),
            "</defs>",
            '<rect x="0" y="0" width="100%" height="100%" fill="#071217"/>',
            (
                '<rect x="24" y="24" width="1032" height="72" rx="18" '
                'fill="#ffffff" fill-opacity=".035" stroke="#ffffff" stroke-opacity=".08"/>'
            ),
            '<text class="title" x="52" y="58">Continuator Memory Graph</text>',
            (
                f'<text class="meta" x="52" y="80">{escape(model_label)} - '
                f'{memory_count} learned phrase{"s" if memory_count != 1 else ""} - '
                f'{total_contexts} contexts - {total_edges} transitions</text>'
            ),
        ]

        for column_index, order in enumerate(orders):
            x = left_margin + column_index * column_gap
            svg_parts.append(
                f'<text class="order" x="{x:.1f}" y="116">ORDER {order}</text>'
            )

        for edge in selected_edges:
            source_key = self._graph_context_key(edge.source)
            target_key = self._graph_context_key(edge.target)
            source_position = node_positions.get(source_key)
            target_position = node_positions.get(target_key)
            if source_position is None or target_position is None:
                continue
            sx = source_position[0] + node_width
            sy = source_position[1] + node_height / 2
            tx = target_position[0]
            ty = target_position[1] + node_height / 2
            if tx <= sx:
                sx = source_position[0] + node_width / 2
                tx = target_position[0] + node_width / 2
                curve = max(64, abs(ty - sy) * 0.5 + 54)
                path = f"M {sx:.1f} {sy:.1f} C {sx + curve:.1f} {sy - curve:.1f}, {tx + curve:.1f} {ty + curve:.1f}, {tx:.1f} {ty:.1f}"
            else:
                curve = max(62, (tx - sx) * 0.42)
                path = f"M {sx:.1f} {sy:.1f} C {sx + curve:.1f} {sy:.1f}, {tx - curve:.1f} {ty:.1f}, {tx:.1f} {ty:.1f}"
            stroke_width = 1.2 + 4.0 * (edge.weight / max_weight) ** 0.5
            svg_parts.append(
                f'<path class="edge" d="{path}" stroke-width="{stroke_width:.2f}" '
                'marker-end="url(#arrow)"/>'
            )
            if len(selected_edges) <= 90:
                lx = (sx + tx) / 2
                ly = (sy + ty) / 2 - 5
                svg_parts.append(
                    f'<text class="edge-label" x="{lx:.1f}" y="{ly:.1f}" '
                    f'text-anchor="middle">{escape(_format_graph_weight(edge.weight))}</text>'
                )

        for key, context in selected_nodes.items():
            x, y = node_positions[key]
            first_symbol = context[0] if context else None
            last_symbol = context[-1] if context else None
            if self._is_start_symbol(first_symbol):
                fill = "#14393d"
                stroke = "#6dd3ce"
            elif self._is_end_symbol(last_symbol):
                fill = "#3b241d"
                stroke = "#f4a261"
            else:
                fill = "#12262d"
                stroke = "#ffffff"
            svg_parts.append(
                f'<rect class="node" x="{x:.1f}" y="{y:.1f}" width="{node_width}" '
                f'height="{node_height}" rx="5" fill="{fill}" stroke="{stroke}"/>'
            )
            label_lines = self._graph_context_label_lines(context)
            svg_parts.append(
                _svg_text_lines(
                    label_lines[:1],
                    x=x + 6,
                    y=y + 13,
                    class_name="node-label",
                    line_height=6,
                )
            )

        truncated_nodes = len(selected_nodes) < total_contexts
        truncated_edges = len(selected_edges) < total_edges
        mode_labels = {
            "slice": "weighted slice",
            "all": "all contexts",
            "most_used": "most-used transitions",
            "neighborhood": "latest phrase neighborhood",
        }
        mode_note = f" - mode: {mode_labels.get(graph_mode, graph_mode)}"
        if order_filter is not None:
            mode_note += f", order {order_filter}"
        truncation_note = ""
        if truncated_nodes or truncated_edges:
            truncation_note = (
                " - showing visible subset"
                f" ({len(selected_nodes)}/{total_contexts} contexts, "
                f"{len(selected_edges)}/{total_edges} transitions)"
            )
        order_summary = ", ".join(
            f"{order}:{count}" for order, count in sorted(context_counts.items())
        )
        svg_parts.append(
            f'<text class="footer" x="52" y="{height - 34}">'
            f'{escape(f"Contexts by order {order_summary}{mode_note}{truncation_note}")}</text>'
        )
        svg_parts.append("</svg>")
        return "\n".join(svg_parts)

    def _render_empty_graph_svg(
        self,
        *,
        width: int,
        height: int,
        model_label: str,
        memory_count: int,
    ) -> str:
        return "\n".join(
            [
                '<svg xmlns="http://www.w3.org/2000/svg" '
                f'viewBox="0 0 {width} {height}" width="{width}" height="{height}" '
                'role="img" aria-labelledby="title desc">',
                "<title id=\"title\">Continuator internal context graph</title>",
                (
                    "<desc id=\"desc\">The Continuator graph is empty because no "
                    "state transitions have been learned yet.</desc>"
                ),
                "<style>",
                "svg{background:#071217;font-family:Avenir Next,Segoe UI,Trebuchet MS,sans-serif}",
                ".title{fill:#ecf4ef;font-size:30px;font-weight:750}",
                ".meta{fill:#9bb8b1;font-size:14px}",
                ".copy{fill:#ecf4ef;font-size:18px;font-weight:700}",
                ".hint{fill:#9bb8b1;font-size:14px}",
                "</style>",
                '<rect x="0" y="0" width="100%" height="100%" fill="#071217"/>',
                (
                    '<rect x="80" y="88" width="920" height="344" rx="28" '
                    'fill="#ffffff" fill-opacity=".04" stroke="#ffffff" stroke-opacity=".1"/>'
                ),
                '<text class="title" x="120" y="148">Continuator Memory Graph</text>',
                (
                    f'<text class="meta" x="120" y="174">{escape(model_label)} - '
                    f'{memory_count} learned phrase{"s" if memory_count != 1 else ""}</text>'
                ),
                '<text class="copy" x="120" y="252">No transitions learned yet.</text>',
                (
                    '<text class="hint" x="120" y="282">Play or import a MIDI phrase, '
                    "then open the graph again.</text>"
                ),
                "</svg>",
            ]
        )

    def render_constraint_graph_svg(
        self,
        *,
        trace: list[GenerationTraceStep] | None,
        constraints: GenerationConstraintsStatus | None,
        request_id: str | None = None,
        created_at: str | None = None,
        max_steps: int = 96,
    ) -> str:
        with self._lock:
            max_steps = max(1, min(240, int(max_steps)))
            return self._render_constraint_graph_svg(
                trace=trace or [],
                constraints=constraints,
                request_id=request_id,
                created_at=created_at,
                max_steps=max_steps,
            )

    def _render_constraint_graph_svg(
        self,
        *,
        trace: list[GenerationTraceStep],
        constraints: GenerationConstraintsStatus | None,
        request_id: str | None,
        created_at: str | None,
        max_steps: int,
    ) -> str:
        width = 1080
        shown_trace = trace[:max_steps]
        columns = 5
        node_width = 172
        node_height = 104
        left_margin = 58
        top_margin = 174
        column_gap = 32
        row_gap = 58
        row_count = max(1, (len(shown_trace) + columns - 1) // columns)
        height = max(560, top_margin + row_count * (node_height + row_gap) + 76)
        context = [
            f"request {request_id[:8]}" if request_id else "no request id",
            created_at or "not generated yet",
            f"{len(trace)} trace step{'s' if len(trace) != 1 else ''}",
        ]
        if len(shown_trace) < len(trace):
            context.append(f"showing first {len(shown_trace)}")

        svg_parts = [
            '<svg xmlns="http://www.w3.org/2000/svg" '
            f'viewBox="0 0 {width} {height}" width="{width}" height="{height}" '
            'role="img" aria-labelledby="title desc">',
            "<title id=\"title\">Continuator constrained generation graph</title>",
            (
                "<desc id=\"desc\">A static graph snapshot of the latest constrained "
                "generation trace.</desc>"
            ),
            "<style>",
            "svg{background:#071217;color:#ecf4ef;font-family:Avenir Next,Segoe UI,Trebuchet MS,sans-serif}",
            ".title{fill:#ecf4ef;font-size:28px;font-weight:750}",
            ".meta{fill:#9bb8b1;font-size:13px}",
            ".badge{fill:#12262d;stroke:#ffffff;stroke-opacity:.14;stroke-width:1}",
            ".badge-text{fill:#ecf4ef;font-size:12px;font-weight:800}",
            ".node{fill:#10252d;stroke:#f4a261;stroke-opacity:.76;stroke-width:1.3;filter:url(#shadow)}",
            ".node-subtle{fill:#9bb8b1;font-size:10px}",
            ".node-label{fill:#ecf4ef;font-size:12px;font-weight:800}",
            ".node-detail{fill:#f7d3b9;font-size:10px;font-weight:700}",
            ".edge{fill:none;stroke:#f4a261;stroke-opacity:.58;stroke-width:2.2}",
            ".empty-title{fill:#ecf4ef;font-size:22px;font-weight:800}",
            ".empty-copy{fill:#9bb8b1;font-size:14px}",
            ".footer{fill:#9bb8b1;font-size:12px}",
            "</style>",
            "<defs>",
            (
                '<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">'
                '<feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="#000" flood-opacity=".28"/>'
                "</filter>"
            ),
            (
                '<marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" '
                'markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
                '<path d="M 0 0 L 10 5 L 0 10 z" fill="#f4a261" fill-opacity=".86"/>'
                "</marker>"
            ),
            "</defs>",
            '<rect x="0" y="0" width="100%" height="100%" fill="#071217"/>',
            (
                '<rect x="24" y="24" width="1032" height="112" rx="18" '
                'fill="#ffffff" fill-opacity=".035" stroke="#ffffff" stroke-opacity=".08"/>'
            ),
            '<text class="title" x="52" y="58">Last Constraint Graph</text>',
            f'<text class="meta" x="52" y="82">{escape(" - ".join(context))}</text>',
        ]

        badge_data = [
            ("Start", constraints.start if constraints else None),
            ("End", constraints.end if constraints else None),
        ]
        for index, (label, state) in enumerate(badge_data):
            x = 52 + index * 240
            y = 100
            value = _constraint_state_label(state)
            if state and state.value:
                value = f"{value}: {self._truncate_graph_label(str(state.value), 22)}"
            svg_parts.append(
                f'<rect class="badge" x="{x}" y="{y}" width="218" height="24" rx="12"/>'
            )
            svg_parts.append(
                f'<text class="badge-text" x="{x + 12}" y="{y + 16}">'
                f'{escape(f"{label} {value}")}</text>'
            )

        if not shown_trace:
            svg_parts.extend(
                [
                    (
                        '<rect x="80" y="190" width="920" height="250" rx="28" '
                        'fill="#ffffff" fill-opacity=".04" stroke="#ffffff" stroke-opacity=".1"/>'
                    ),
                    '<text class="empty-title" x="120" y="260">No constrained generation trace yet.</text>',
                    (
                        '<text class="empty-copy" x="120" y="292">Generate from memory or send a phrase, '
                        "then open this tab again.</text>"
                    ),
                    (
                        '<text class="empty-copy" x="120" y="322">This view is kept separate from the '
                        "learned memory graph because it is tied to one generation request.</text>"
                    ),
                    "</svg>",
                ]
            )
            return "\n".join(svg_parts)

        positions: list[tuple[float, float]] = []
        for index, _step in enumerate(shown_trace):
            column = index % columns
            row = index // columns
            if row % 2 == 0:
                column_index = column
            else:
                column_index = columns - 1 - column
            x = left_margin + column_index * (node_width + column_gap)
            y = top_margin + row * (node_height + row_gap)
            positions.append((x, y))

        for index in range(1, len(positions)):
            source_x, source_y = positions[index - 1]
            target_x, target_y = positions[index]
            sx = source_x + node_width / 2
            sy = source_y + node_height
            tx = target_x + node_width / 2
            ty = target_y
            if abs(source_y - target_y) < 1:
                sx = source_x + (node_width if target_x > source_x else 0)
                sy = source_y + node_height / 2
                tx = target_x + (0 if target_x > source_x else node_width)
                ty = target_y + node_height / 2
            curve = max(40, abs(tx - sx) * 0.28 + abs(ty - sy) * 0.18)
            path = (
                f"M {sx:.1f} {sy:.1f} C {sx:.1f} {sy + curve:.1f}, "
                f"{tx:.1f} {ty - curve:.1f}, {tx:.1f} {ty:.1f}"
            )
            if abs(source_y - target_y) < 1:
                path = (
                    f"M {sx:.1f} {sy:.1f} C {(sx + tx) / 2:.1f} {sy:.1f}, "
                    f"{(sx + tx) / 2:.1f} {ty:.1f}, {tx:.1f} {ty:.1f}"
                )
            svg_parts.append(f'<path class="edge" d="{path}" marker-end="url(#arrow)"/>')

        for index, step in enumerate(shown_trace):
            x, y = positions[index]
            symbol_label = self._truncate_graph_label(
                self._trace_symbol_label(step.symbol),
                24,
            )
            policy = step.policy or "generation"
            candidates = ", ".join(
                f"k{order}:{count}"
                for order, count in zip(step.candidate_orders, step.candidate_counts)
            )
            if not candidates:
                candidates = f"k{step.order}"
            context_label = " / ".join(
                self._truncate_graph_label(self._trace_symbol_label(value), 10)
                for value in step.context[-3:]
            )
            if not context_label:
                context_label = "free start" if step.order == 0 else "empty"

            svg_parts.append(
                f'<rect class="node" x="{x:.1f}" y="{y:.1f}" width="{node_width}" '
                f'height="{node_height}" rx="16"/>'
            )
            svg_parts.append(
                f'<text class="node-subtle" x="{x + 12:.1f}" y="{y + 18:.1f}">'
                f'{escape(f"position {step.position} - order {step.order}")}</text>'
            )
            svg_parts.append(
                _svg_text_lines(
                    self._wrap_graph_label(symbol_label, limit=22, max_lines=2),
                    x=x + 12,
                    y=y + 42,
                    class_name="node-label",
                    line_height=14,
                )
            )
            svg_parts.append(
                f'<text class="node-detail" x="{x + 12:.1f}" y="{y + 76:.1f}">'
                f'{escape(self._truncate_graph_label(policy, 24))}</text>'
            )
            svg_parts.append(
                f'<text class="node-subtle" x="{x + 12:.1f}" y="{y + 94:.1f}">'
                f'{escape(self._truncate_graph_label(candidates, 28))}</text>'
            )
            svg_parts.append(
                f'<title>{escape(f"context: {context_label}")}</title>'
            )

        footer_copy = (
            "Trace path after compiling/gating the generation constraints. "
            "This is distinct from the learned memory graph."
        )
        svg_parts.append(
            f'<text class="footer" x="52" y="{height - 34}">'
            f"{escape(footer_copy)}</text>"
        )
        svg_parts.append("</svg>")
        return "\n".join(svg_parts)

    def get_memory_snapshot(self) -> tuple[list[PhrasePayload], int]:
        with self._lock:
            sequences = self._input_sequences()
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

    def replace_live_memory(self, payloads: list[PhrasePayload]) -> list[PhrasePayload]:
        with self._lock:
            self._continuator = self._create_engine(load_seed_material=True)
            rebuilt_payloads: list[PhrasePayload] = []
            for payload in payloads:
                phrase_events = [MidiEvent.model_validate(event) for event in payload.events]
                try:
                    rebuilt_payloads.append(
                        self._learn_phrase_events_locked(
                            phrase_events,
                            transpose=False,
                        )
                    )
                except NoContinuationAvailable:
                    continue
            return rebuilt_payloads

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
                    reason=None if enforce_end_constraint else "Ending constraint was disabled.",
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
                constraints_status.start.reason = "The exact-start version had no solution."
                status_messages.append(
                    "Generated from memory without the hard start constraint "
                    "because the exact-start version had no solution."
                )
            if enforce_end_constraint and not applied_end_constraint:
                constraints_status.end.applied = False
                constraints_status.end.relaxed = True
                constraints_status.end.reason = "The exact-ending version had no solution."
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
            trace_initial_context = (
                [self._continuator.get_start_vp()] if applied_start_constraint else []
            )
            return (
                _build_phrase_payload(rendered_sequence),
                constraints_status,
                self._generation_trace_or_path(
                    generated_sequence,
                    initial_context=trace_initial_context,
                ),
                " ".join(status_messages) or None,
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
                if self._has_viewpoint(requested_handoff_viewpoint):
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
                if not self._has_viewpoint(input_handoff_viewpoint):
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
            trace_initial_context: list[object] = []
            if constraints_status.start.applied:
                if start_viewpoint is not None:
                    trace_initial_context = [start_viewpoint]
                elif prefix_for_generation is not None:
                    trace_initial_context = [
                        self._continuator.get_viewpoint(note) for note in prefix_for_generation
                    ]
            return (
                input_payload,
                _build_phrase_payload(rendered_sequence),
                constraints_status,
                self._generation_trace_or_path(
                    generated_sequence,
                    initial_context=trace_initial_context,
                ),
                status_message,
            )
