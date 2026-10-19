"""Integration checks against the installed engine and HTTP API."""

from __future__ import annotations

import json
from io import BytesIO
import mido
import pytest
from app.continuator_adapter import ContinuatorSessionEngine
from app.schemas import ViewpointSeed
from app.session_manager import SessionManager
from .helpers import create_session, learn, pitch_events


@pytest.mark.parametrize(
    "start,end", [(True, True), (True, False), (False, True), (False, False)]
)
def test_generate_constraints_and_native_traces(phrase, start, end):
    engine = ContinuatorSessionEngine()
    engine.learn_phrase_events(phrase)
    payload, constraints, trace, _ = engine.generate_phrase(
        note_count=4,
        enforce_start_constraint=start,
        enforce_end_constraint=end,
    )
    assert payload.note_count == 4
    assert constraints.start.requested == start
    assert constraints.end.requested == end
    assert constraints.start.applied == start
    assert constraints.end.applied == end
    assert trace
    assert all(step.policy != "generated path" for step in trace)
    serialized = json.dumps([step.model_dump() for step in trace])
    assert "object at 0x" not in serialized
    if start:
        assert trace[0].context == ["START"]
    if end:
        assert trace[-1].symbol == "END"


def test_order_rebuild_preserves_transposed_memory_without_pruning(phrase):
    engine = ContinuatorSessionEngine(
        transposition=True, forget_past=True, keep_last_inputs=2
    )
    engine.learn_phrase_events(phrase)
    before, seeds_before = engine.get_memory_snapshot()
    assert len(before) == 12
    engine.apply_settings(markov_order=2)
    after, seeds_after = engine.get_memory_snapshot()
    assert after == before
    assert seeds_after == seeds_before
    assert engine.generate_phrase(note_count=4)[0].note_count == 4
    # The rolling cap still applies to subsequent input.
    engine.apply_settings(transposition=False)
    engine.learn_phrase_events(phrase)
    assert len(engine.get_memory_snapshot()[0]) == 2


@pytest.mark.parametrize("learn_input", [False, True])
def test_continuation_keeps_played_prefix_before_relaxing_ending(learn_input):
    engine = ContinuatorSessionEngine()
    engine.learn_phrase_events(pitch_events([60, 62, 64, 65, 67, 69, 71, 72]))
    _, output, constraints, trace, message = engine.continue_phrase(
        pitch_events([60, 62]),
        learn_input=learn_input,
        continuation_note_count=4,
    )
    assert [note.pitch for note in output.notes] == [64, 65, 67, 69]
    assert constraints.start.applied and not constraints.start.relaxed
    assert constraints.end.relaxed and not constraints.end.applied
    assert trace[0].context[-1][0] == 62
    assert "end constraint" in message


def test_continuation_keeps_prefix_and_ending_when_both_are_feasible():
    engine = ContinuatorSessionEngine()
    engine.learn_phrase_events(pitch_events([60, 62, 64, 65, 67, 69, 71, 72]))
    _, output, constraints, _, message = engine.continue_phrase(
        pitch_events([60, 62]),
        learn_input=False,
        continuation_note_count=6,
    )
    assert [note.pitch for note in output.notes] == [64, 65, 67, 69, 71, 72]
    assert constraints.start.applied and constraints.end.applied
    assert message is None


def test_prefix_backs_off_order_before_relaxing_ending():
    engine = ContinuatorSessionEngine(markov_order=4)
    # C-D's order-2 path E-F-F# cannot reach END after two notes.
    # The order-1 suffix D also has A-B-END, which meets the request.
    for pitches in ([60, 62, 64, 65, 66], [67, 62, 69, 71]):
        engine.learn_phrase_events(pitch_events(pitches))
    _, output, constraints, trace, message = engine.continue_phrase(
        pitch_events([60, 62]),
        learn_input=False,
        continuation_note_count=2,
    )
    assert [note.pitch for note in output.notes] == [69, 71]
    assert constraints.start.applied and not constraints.start.relaxed
    assert constraints.end.applied and not constraints.end.relaxed
    assert trace[0].order == 1
    assert trace[0].context == [[62, 0, False, False]]
    assert message is None


def test_uncontinuable_prefix_explicitly_reports_fresh_memory_fallback():
    engine = ContinuatorSessionEngine()
    engine.learn_phrase_events(pitch_events([60, 62, 64, 65]))
    _, output, constraints, trace, message = engine.continue_phrase(
        pitch_events([65]),
        learn_input=False,
        continuation_note_count=4,
    )
    assert output.note_count == 4
    assert constraints.start.relaxed and not constraints.start.applied
    assert trace[0].context == ["<FREE>"]
    assert "fresh phrase from memory" in message


@pytest.mark.parametrize(
    "prefix,successors", [([60, 62], {64, 65}), ([67, 62], {69, 71})]
)
def test_preserved_handoff_retains_earlier_prefix_context(prefix, successors):
    engine = ContinuatorSessionEngine()
    for pitches in (
        [60, 62, 64, 65],
        [60, 62, 65, 66],
        [67, 62, 69, 71],
        [67, 62, 71, 72],
    ):
        engine.learn_phrase_events(pitch_events(pitches))
    _, output, constraints, trace, _ = engine.continue_phrase(
        pitch_events(prefix),
        learn_input=False,
        continuation_note_count=1,
        enforce_end_constraint=False,
        handoff_viewpoint=ViewpointSeed(
            pitch=62,
            duration_bin=0,
            overlaps_left=False,
            overlaps_right=False,
        ),
    )
    assert output.notes[0].pitch in successors
    assert constraints.start.applied and not constraints.start.relaxed
    assert [viewpoint[0] for viewpoint in trace[0].context] == prefix
    assert trace[0].order == 2


def test_unknown_preserved_handoff_falls_back_to_played_prefix():
    engine = ContinuatorSessionEngine()
    engine.learn_phrase_events(pitch_events([60, 62, 64, 65]))
    _, output, constraints, _, message = engine.continue_phrase(
        pitch_events([60, 62]),
        learn_input=False,
        continuation_note_count=2,
        handoff_viewpoint=ViewpointSeed(
            pitch=127,
            duration_bin=0,
            overlaps_left=False,
            overlaps_right=False,
        ),
    )
    assert [note.pitch for note in output.notes] == [64, 65]
    assert constraints.start.applied and not constraints.start.relaxed
    assert "using the played phrase instead" in message


def test_http_continuation_returns_successors_of_played_prefix(api):
    client, _ = api
    session_id = create_session(client)
    learn(client, session_id, pitch_events([60, 62, 64, 65, 67, 69, 71, 72]))
    payload = learn(client, session_id, pitch_events([60, 62]))
    assert [note["pitch"] for note in payload["generated_phrase"]["notes"]] == [
        64,
        65,
        67,
        69,
    ]
    assert payload["constraints"]["start"]["applied"]
    assert payload["constraints"]["end"]["relaxed"]


def test_http_learning_graphs_settings_and_reset(api, phrase):
    client, _ = api
    assert client.get("/health").json()["continuator"]["version"] == "2.0.0"
    session_id = create_session(client)
    empty = client.post(f"/api/sessions/{session_id}/generate", json={"note_count": 4})
    assert empty.status_code == 409
    learn(client, session_id, phrase)
    for mode in ("slice", "all", "most_used", "neighborhood"):
        response = client.get(
            f"/api/sessions/{session_id}/graphs/memory.svg", params={"mode": mode}
        )
        assert response.status_code == 200, response.text
        assert "<svg" in response.text
        assert "VO Regular BP" in response.text
    response = client.get(f"/api/sessions/{session_id}/graphs/constraints.svg")
    assert response.status_code == 200, response.text
    assert "<svg" in response.text
    memory_url = f"/api/sessions/{session_id}/memory"
    before = client.get(memory_url).json()["items"]
    response = client.patch(
        f"/api/sessions/{session_id}/settings", json={"markov_order": 2}
    )
    assert response.status_code == 200, response.text
    assert response.json()["configuration"]["markov_order"] == 2
    assert client.get(memory_url).json()["items"] == before
    generated = client.post(
        f"/api/sessions/{session_id}/generate", json={"note_count": 4}
    )
    assert generated.status_code == 200, generated.text
    assert generated.json()["generated_phrase"]["note_count"] == 4
    response = client.post(f"/api/sessions/{session_id}/reset")
    assert response.status_code == 200
    assert client.get(memory_url).json()["summary"]["active_phrase_count"] == 0


@pytest.mark.parametrize("old_engine", ["classic", "context_bp", "vo_regular_bp"])
def test_reopen_legacy_saved_session_after_restart(api, phrase, old_engine):
    client, main = api
    registered = client.post(
        "/api/auth/register",
        json={"username": "migration_user", "password": "test-password-123"},
    )
    assert registered.status_code == 200, registered.text
    user_id = registered.json()["user"]["id"]
    session_id = create_session(client)
    learn(client, session_id, phrase)
    record = main.storage.get_session_record(session_id, user_id)
    metadata = record["metadata"] | {"engine_kind": old_engine, "decay_mode": "late"}
    main.storage.update_session_metadata(session_id, metadata, record["last_seen_at"])
    # A fresh manager exercises restoration from SQLite, not cached state.
    main.session_manager = SessionManager(main.storage)
    restored = client.post(f"/api/my/sessions/{session_id}/open")
    assert restored.status_code == 200, restored.text
    assert restored.json()["restored_from_history"]
    assert restored.json()["restored_phrase_count"] == 1
    assert "engine_kind" not in restored.json()["configuration"]
    generated = client.post(
        f"/api/sessions/{session_id}/generate", json={"note_count": 4}
    )
    assert generated.status_code == 200, generated.text
    listed = client.get("/api/my/sessions").json()["items"]
    assert len(listed) == 1
    assert "decay_mode" not in listed[0]["configuration"]


def test_midi_import_and_export(api, phrase):
    client, _ = api
    session_id = create_session(client)
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
        files=[("files", ("phrase.mid", output.getvalue(), "audio/midi"))],
    )
    assert response.status_code == 200, response.text
    assert response.json()["imported_file_count"] == 1
    assert (
        client.get(f"/api/sessions/{session_id}/memory").json()["summary"][
            "active_phrase_count"
        ]
        == 1
    )
    generated = client.post(
        f"/api/sessions/{session_id}/generate", json={"note_count": 4}
    )
    assert generated.status_code == 200, generated.text
    response = client.post(f"/api/sessions/{session_id}/save-midi")
    assert response.status_code == 200, response.text
