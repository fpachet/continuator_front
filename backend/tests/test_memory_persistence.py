from __future__ import annotations

import json
from io import BytesIO
import mido
import pytest
from app.continuator_adapter import ContinuatorSessionEngine
from app.schemas import MidiEvent
from app.session_manager import SessionManager
from .helpers import create_session, learn, pitch_events


def test_same_second_reset_and_learning_restore_exactly(api, monkeypatch):
    client, main = api
    monkeypatch.setattr(
        "app.session_manager.utc_now_iso", lambda: "2026-10-19T18:00:00Z"
    )
    session_id = create_session(client)
    learn(client, session_id, pitch_events([60, 62, 64, 65]))
    assert client.post(f"/api/sessions/{session_id}/reset").status_code == 200
    learn(client, session_id, pitch_events([67, 69, 71, 72]))
    expected = client.get(f"/api/sessions/{session_id}/memory").json()["items"]
    main.session_manager = SessionManager(main.storage)
    actual = client.get(f"/api/sessions/{session_id}/memory").json()["items"]
    assert actual == expected
    assert len(actual) == 1
    assert [note["pitch"] for note in actual[0]["payload"]["notes"]] == [67, 69, 71, 72]
    assert len(main.storage.get_rebuild_phrases(session_id)) == 1
    assert main.storage.count_continuation_requests(session_id) == 1


def test_learning_order_uses_sequence_instead_of_time_or_uuid(api):
    client, main = api
    session_id = create_session(client)
    for phrase_id, timestamp in (
        ("z-first", "2026-10-19T18:00:01Z"),
        ("a-second", "2026-10-19T18:00:00Z"),
    ):
        main.storage.log_phrase(
            phrase_id, phrase_id, session_id, "input", timestamp, True, {}
        )
    assert [
        row["id"] for row in main.storage.get_rebuild_phrase_records(session_id)
    ] == ["z-first", "a-second"]
    assert [row["id"] for row in main.storage.get_history(session_id)] == [
        "a-second",
        "z-first",
    ]


def test_transposed_variant_identity_deletion_and_restart(api):
    client, main = api
    session_id = create_session(client, transposition=True)
    learn(client, session_id, pitch_events([60, 62, 64, 65]))
    url = f"/api/sessions/{session_id}/memory"
    before = client.get(url).json()["items"]
    assert len(before) == 12
    assert all(item["deletable"] and item["phrase_id"] for item in before)
    assert len({item["phrase_id"] for item in before}) == 1
    assert len({item["memory_id"] for item in before}) == 12
    target = before[4]
    response = client.delete(
        f"{url}/{target['slot']}", params={"memory_id": target["memory_id"]}
    )
    assert response.status_code == 200, response.text
    remaining_ids = [item["memory_id"] for item in response.json()["items"]]
    assert remaining_ids == [item["memory_id"] for item in before if item != target]
    # A stale view cannot delete whichever variant moved into the old slot.
    stale = client.delete(
        f"{url}/{target['slot']}", params={"memory_id": target["memory_id"]}
    )
    assert stale.status_code == 400
    main.session_manager = SessionManager(main.storage)
    restored = client.get(url).json()["items"]
    assert [item["memory_id"] for item in restored] == remaining_ids
    response = client.patch(
        f"/api/sessions/{session_id}/settings",
        json={"transposition": False, "markov_order": 2},
    )
    assert response.status_code == 200
    main.session_manager = SessionManager(main.storage)
    assert client.get(url).json()["items"] == restored


def test_seed_identity_survives_rolling_eviction_and_reset(tmp_path):
    from app.midi_export import phrase_payload_to_midi_bytes
    from app.schemas import CreateSessionRequest, ContinueRequest
    from app.storage import PhraseStorage

    seed_engine = ContinuatorSessionEngine()
    seed_payload = seed_engine.learn_phrase_events(pitch_events([48, 50, 52, 53]))
    seed_file = tmp_path / "seed.mid"
    seed_file.write_bytes(phrase_payload_to_midi_bytes(seed_payload))
    storage = PhraseStorage(tmp_path / "seeds.sqlite3")
    manager = SessionManager(storage, seed_midi_file=seed_file)
    session_id = manager.create_session(
        CreateSessionRequest(forget_past=True, keep_last_inputs=1), None
    ).session_id
    assert manager.get_memory(session_id, None).summary.seeded_phrase_count == 1
    manager.continue_phrase(
        ContinueRequest(
            session_id=session_id,
            phrase=pitch_events([60, 62, 64, 65]),
            continuation_note_count=4,
        ),
        None,
    )
    memory = manager.get_memory(session_id, None)
    assert memory.summary.seeded_phrase_count == 0
    assert memory.summary.live_phrase_count == 1 and memory.items[0].deletable
    manager.reset_session(session_id, None)
    expected = manager.get_memory(session_id, None)
    assert expected.summary.seeded_phrase_count == 1
    restored = SessionManager(storage, seed_midi_file=seed_file).get_memory(
        session_id, None
    )
    assert restored.items == expected.items


def test_import_skips_keep_correct_source_ids(api, phrase):
    client, main = api
    session_id = create_session(client, transposition=True)
    midi_file = mido.MidiFile()
    track = mido.MidiTrack()
    midi_file.tracks.append(track)
    for event in phrase:
        track.append(
            mido.Message(
                event.type,
                note=event.note,
                velocity=event.velocity,
                time=round(event.delta_seconds * 960),
            )
        )
    output = BytesIO()
    midi_file.save(file=output)
    response = client.post(
        f"/api/sessions/{session_id}/import-midi",
        files=[
            ("files", ("invalid.txt", b"skip", "text/plain")),
            ("files", ("phrase.mid", output.getvalue(), "audio/midi")),
        ],
    )
    assert response.status_code == 200, response.text
    source = main.storage.get_rebuild_phrase_records(session_id)[0]["id"]
    assert source.endswith("-import-0001")
    memory = client.get(f"/api/sessions/{session_id}/memory").json()["items"]
    assert len(memory) == 12 and all(item["phrase_id"] == source for item in memory)


def test_failed_generation_log_rolls_back_history_and_engine(api, monkeypatch):
    client, main = api
    from app.schemas import ContinueRequest

    session_id = create_session(client)
    learn(client, session_id, pitch_events([60, 62, 64, 65]))
    before_history = main.storage.get_history(session_id)
    before_memory = main.session_manager.get_memory(session_id, None).items
    original_log = main.storage.log_phrase

    def fail_generated(**kwargs):
        if kwargs["kind"] == "generated":
            raise RuntimeError("simulated disk failure")
        return original_log(**kwargs)

    monkeypatch.setattr(main.storage, "log_phrase", fail_generated)
    with pytest.raises(RuntimeError, match="simulated disk failure"):
        main.session_manager.continue_phrase(
            ContinueRequest(
                session_id=session_id,
                phrase=pitch_events([67, 69, 71, 72]),
                continuation_note_count=4,
            ),
            None,
        )
    assert main.storage.get_history(session_id) == before_history
    assert main.session_manager.get_memory(session_id, None).items == before_memory


def test_migration_preserves_legacy_insertion_order_and_reset_membership(tmp_path):
    import sqlite3
    from app.schemas import CreateSessionRequest
    from app.storage import PhraseStorage, SCHEMA_SQL

    path = tmp_path / "legacy.sqlite3"
    metadata = CreateSessionRequest().model_dump() | {
        "seeded": False,
        "engine_kind": "classic",
        "decay_mode": "full",
    }
    seed_engine = ContinuatorSessionEngine()
    payload = seed_engine.learn_phrase_events(
        pitch_events([60, 62, 64, 65])
    ).model_dump(mode="json")
    with sqlite3.connect(path) as connection:
        connection.executescript(SCHEMA_SQL)
        connection.execute(
            "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)",
            (
                "legacy",
                None,
                "2026-10-19T17:00:00Z",
                "2026-10-19T18:00:01Z",
                "2026-10-19T18:00:00Z",
                json.dumps(metadata),
            ),
        )
        for phrase_id, timestamp in (
            ("old", "2026-10-19T17:00:00Z"),
            ("z-first", "2026-10-19T18:00:01Z"),
            ("a-second", "2026-10-19T18:00:01Z"),
        ):
            connection.execute(
                "INSERT INTO phrases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    phrase_id,
                    phrase_id,
                    "legacy",
                    "input",
                    timestamp,
                    payload["event_count"],
                    payload["note_count"],
                    payload["duration_seconds"],
                    1,
                    json.dumps(payload),
                ),
            )
    storage = PhraseStorage(path)
    assert [
        record["id"] for record in storage.get_rebuild_phrase_records("legacy")
    ] == ["z-first", "a-second"]
    manager = SessionManager(storage)
    memory = manager.get_memory("legacy", None)
    assert [item.phrase_id for item in memory.items] == ["z-first", "a-second"]
    # Migration and exact snapshot restoration remain stable on later startups.
    repeated = SessionManager(PhraseStorage(path)).get_memory("legacy", None)
    assert repeated.items == memory.items


def test_failed_settings_save_restores_previous_configuration_and_memory(
    api, monkeypatch
):
    from app.schemas import UpdateSessionSettingsRequest

    client, main = api
    session_id = create_session(client, transposition=True)
    learn(client, session_id, pitch_events([60, 62, 64, 65]))
    before = main.session_manager.get_memory(session_id, None)

    def fail_save(*args, **kwargs):
        raise RuntimeError("simulated memory write failure")

    monkeypatch.setattr(main.storage, "save_memory", fail_save)
    with pytest.raises(RuntimeError, match="simulated memory write failure"):
        main.session_manager.update_session_settings(
            session_id,
            None,
            UpdateSessionSettingsRequest(
                markov_order=2,
                transposition=False,
            ),
        )
    restored = main.session_manager.get_memory(session_id, None)
    assert restored.configuration == before.configuration
    assert restored.items == before.items


def test_exact_memory_restore_preserves_polyphonic_note_state(api):
    from app.schemas import ContinueRequest, UpdateSessionSettingsRequest

    client, main = api
    session_id = create_session(client)
    phrase = [
        MidiEvent(type="note_on", note=60, velocity=90, delta_seconds=0),
        MidiEvent(type="note_on", note=64, velocity=80, delta_seconds=0.25),
        MidiEvent(type="note_off", note=60, velocity=0, delta_seconds=0.25),
        MidiEvent(type="note_off", note=64, velocity=0, delta_seconds=0.25),
    ]
    main.session_manager.continue_phrase(
        ContinueRequest(
            session_id=session_id, phrase=phrase, continuation_note_count=2
        ),
        None,
    )
    before = main.storage.load_memory(session_id)
    assert json.loads(before[0]["notes_json"])[0]["next_start_delta"] < 0
    main.session_manager.update_session_settings(
        session_id,
        None,
        UpdateSessionSettingsRequest(markov_order=2, transposition=True),
    )
    restored = SessionManager(main.storage)
    restored.get_memory(session_id, None)
    assert restored._sessions[session_id].engine.get_memory_records() == before
