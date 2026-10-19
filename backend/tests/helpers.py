from app.schemas import MidiEvent


def create_session(client, **settings):
    response = client.post("/api/session", json=settings)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert "engine_kind" not in payload["configuration"]
    assert "decay_mode" not in payload["configuration"]
    return payload["session_id"]


def learn(client, session_id, phrase):
    response = client.post(
        "/api/continue",
        json={
            "session_id": session_id,
            "phrase": [event.model_dump() for event in phrase],
            "continuation_note_count": 4,
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["generated_phrase"]["note_count"] == 4
    assert response.json()["generation_trace"]
    return response.json()


def pitch_events(pitches):
    return [
        MidiEvent(type=kind, note=pitch, velocity=velocity, delta_seconds=delta)
        for pitch in pitches
        for kind, velocity, delta in (("note_on", 90, 0), ("note_off", 0, 0.25))
    ]
