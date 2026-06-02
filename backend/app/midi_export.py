from __future__ import annotations

from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import mido

from .schemas import PhrasePayload


MIDI_EXPORT_TEMPO = 500_000
MIDI_EXPORT_TICKS_PER_BEAT = 480


def phrase_payload_to_midi_bytes(payload: PhrasePayload) -> bytes:
    midi_file = mido.MidiFile(type=0, ticks_per_beat=MIDI_EXPORT_TICKS_PER_BEAT)
    track = mido.MidiTrack()
    midi_file.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=MIDI_EXPORT_TEMPO, time=0))

    current_seconds = 0.0
    previous_tick = 0
    for event in payload.events:
        current_seconds += float(event.delta_seconds)
        absolute_tick = max(
            previous_tick,
            int(
                round(
                    mido.second2tick(
                        current_seconds,
                        MIDI_EXPORT_TICKS_PER_BEAT,
                        MIDI_EXPORT_TEMPO,
                    )
                )
            ),
        )
        delta_ticks = absolute_tick - previous_tick
        previous_tick = absolute_tick
        velocity = int(event.velocity) if event.type == "note_on" else 0
        track.append(
            mido.Message(
                event.type,
                note=int(event.note),
                velocity=velocity,
                channel=int(event.channel),
                time=delta_ticks,
            )
        )

    track.append(mido.MetaMessage("end_of_track", time=0))
    buffer = BytesIO()
    midi_file.save(file=buffer)
    return buffer.getvalue()


def write_phrase_payload_midi(payload: PhrasePayload, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(phrase_payload_to_midi_bytes(payload))


def midi_files_to_zip_bytes(files: list[tuple[str, bytes]]) -> bytes:
    buffer = BytesIO()
    with ZipFile(buffer, mode="w", compression=ZIP_DEFLATED) as archive:
        for file_name, content in files:
            archive.writestr(file_name, content)
    return buffer.getvalue()
