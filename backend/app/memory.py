"""Stable identities and lossless note snapshots for active memory variants."""

from __future__ import annotations

from dataclasses import dataclass
import json
import uuid

from midi_stuff.mini_muse import Note


@dataclass(frozen=True)
class MemoryVariant:
    id: str
    source_phrase_id: str | None
    is_seed: bool
    notes_json: str

    @classmethod
    def from_notes(cls, notes, *, source_phrase_id=None, is_seed=False):
        return cls(
            id=uuid.uuid4().hex,
            source_phrase_id=source_phrase_id,
            is_seed=is_seed,
            notes_json=json.dumps(
                [
                    {
                        "pitch": int(note.pitch),
                        "velocity": int(note.velocity),
                        "duration": float(note.duration),
                        "start_time": float(note.start_time),
                        "next_start_delta": float(note.next_start_delta),
                        "overlaps_left_flag": bool(note.overlaps_left()),
                    }
                    for note in notes
                ],
                separators=(",", ":"),
            ),
        )

    @classmethod
    def from_record(cls, record):
        return cls(
            id=str(record["id"]),
            source_phrase_id=record["source_phrase_id"],
            is_seed=bool(record["is_seed"]),
            notes_json=str(record["notes_json"]),
        )

    def record(self):
        return {
            "id": self.id,
            "source_phrase_id": self.source_phrase_id,
            "is_seed": self.is_seed,
            "notes_json": self.notes_json,
        }

    def notes(self):
        notes = []
        for data in json.loads(self.notes_json):
            note = Note(
                data["pitch"], data["velocity"], data["duration"], data["start_time"]
            )
            note.next_start_delta = data["next_start_delta"]
            note.overlaps_left_flag = data["overlaps_left_flag"]
            notes.append(note)
        return notes
