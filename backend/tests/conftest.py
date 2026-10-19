import importlib
import pytest
from fastapi.testclient import TestClient
from app.schemas import MidiEvent


@pytest.fixture
def phrase():
    return [
        MidiEvent(type=kind, note=pitch, velocity=velocity, delta_seconds=delta)
        for pitch in (60, 62, 64, 65)
        for kind, velocity, delta in (("note_on", 90, 0), ("note_off", 0, 0.25))
    ]


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("CONTINUATOR_DB_PATH", str(tmp_path / "test.sqlite3"))
    monkeypatch.setenv("CONTINUATOR_SESSION_EXPORT_DIR", str(tmp_path / "exports"))
    monkeypatch.delenv("CONTINUATOR_SEED_MIDI_FILE", raising=False)
    monkeypatch.delenv("CONTINUATOR_SEED_MIDI_FOLDER", raising=False)
    from app import main

    importlib.reload(main)
    with TestClient(main.app) as client:
        yield client, main
