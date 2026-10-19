from pathlib import Path
import json
import sqlite3
import threading

import pytest

from app.auth import AuthManager
from app.cloud_backup import CloudBackup, MANIFEST, PREFIX
from app.session_manager import SessionManager
from app.storage import PhraseStorage


class FakeBucket:
    def __init__(self):
        self.files = {}
        self.fail = None
        self.on_snapshot = None
        self.private = True

    def check_private(self):
        if not self.private:
            raise ValueError("private bucket required")

    def manifest(self):
        return json.loads(self.files[MANIFEST]) if MANIFEST in self.files else None

    def upload(self, source, name):
        if self.fail == name or self.fail == "all":
            raise OSError("network failed")
        self.files[name] = source.read_bytes() if isinstance(source, Path) else source
        if name.endswith(".sqlite3") and self.on_snapshot:
            self.on_snapshot()

    def download(self, name, path):
        path.write_bytes(self.files[name])

    def prune(self, keep):
        for name in list(self.files):
            if (
                name.startswith(PREFIX)
                and name.endswith(".sqlite3")
                and name not in keep
            ):
                del self.files[name]


def setup_backup(tmp_path):
    storage = PhraseStorage(tmp_path / "local.sqlite3")
    remote = FakeBucket()
    backup = CloudBackup(storage.db_path, remote)
    backup.storage = storage
    return storage, remote, backup


def test_restore_preserves_accounts_phrases_memory_and_ownership(api, phrase, tmp_path):
    client, main = api
    session_id = client.post("/api/session", json={"transposition": False}).json()[
        "session_id"
    ]
    assert client.post(
        "/api/continue",
        json={
            "session_id": session_id,
            "phrase": [event.model_dump() for event in phrase],
        },
    ).is_success
    client.post(
        "/api/auth/register", json={"username": "musician", "password": "test-password"}
    )
    assert client.post(f"/api/my/sessions/{session_id}/claim").is_success
    memory = client.get(f"/api/sessions/{session_id}/memory").json()
    history = client.get(f"/api/sessions/{session_id}/history").json()
    remote = FakeBucket()
    backup = CloudBackup(main.storage.db_path, remote)
    backup.storage = main.storage
    assert backup.save_once()
    restored_path = tmp_path / "fresh-container" / "database.sqlite3"
    recovery = CloudBackup(restored_path, remote)
    recovery.restore()
    restored = PhraseStorage(restored_path)
    user, _ = AuthManager(restored).login("musician", "test-password")
    manager = SessionManager(restored)
    assert manager.get_memory(session_id, user.id).model_dump(mode="json") == memory
    assert (
        manager.get_history(session_id, user.id, limit=12).model_dump(mode="json")
        == history
    )
    assert manager.list_user_sessions(user.id).items[0].session_id == session_id


def test_writes_during_upload_are_not_reported_as_saved(tmp_path):
    storage, remote, backup = setup_backup(tmp_path)
    remote.on_snapshot = lambda: storage.create_session("new", None, "now", {})
    assert backup.save_once()
    assert backup.status()["status"] == "saving"
    remote.on_snapshot = None
    assert backup.save_once()
    assert backup.status()["status"] == "saved"


def test_failed_manifest_publish_keeps_last_good_backup_and_retries(tmp_path):
    storage, remote, backup = setup_backup(tmp_path)
    assert backup.save_once()
    previous = remote.files[MANIFEST]
    storage.create_session("new", None, "now", {})
    remote.fail = MANIFEST
    assert not backup.save_once()
    assert backup.status()["status"] == "failed"
    assert remote.files[MANIFEST] == previous
    restored = CloudBackup(tmp_path / "recovered.sqlite3", remote)
    restored.restore()
    assert not PhraseStorage(restored.db_path).session_exists("new", None)
    remote.fail = None
    assert backup.save_once()
    assert backup.status()["status"] == "saved"


def test_corrupt_snapshot_and_unavailable_remote_fail_closed(tmp_path):
    storage, remote, backup = setup_backup(tmp_path)
    assert backup.save_once()
    remote.files[remote.manifest()["snapshot"]] = b"not a database"
    destination = tmp_path / "empty.sqlite3"
    with pytest.raises(ValueError, match="checksum"):
        CloudBackup(destination, remote).restore()
    assert not destination.exists()
    remote.manifest = lambda: (_ for _ in ()).throw(OSError("offline"))
    with pytest.raises(OSError):
        CloudBackup(destination, remote).restore()
    assert not destination.exists()


def test_private_bucket_required_and_three_snapshots_retained(tmp_path):
    storage, remote, backup = setup_backup(tmp_path)
    remote.private = False
    assert not backup.save_once()
    assert not remote.files
    with pytest.raises(ValueError, match="private"):
        CloudBackup(tmp_path / "fresh.sqlite3", remote).restore()
    remote.private = True
    for index in range(5):
        storage.create_session(str(index), None, "now", {})
        assert backup.save_once()
    assert len([name for name in remote.files if name.endswith(".sqlite3")]) == 3


def test_newer_local_data_survives_restore_and_different_database_is_rejected(tmp_path):
    storage, remote, backup = setup_backup(tmp_path)
    assert backup.save_once()
    storage.create_session("unsynced", None, "now", {})
    CloudBackup(storage.db_path, remote).restore()
    assert storage.session_exists("unsynced", None)
    other = PhraseStorage(tmp_path / "other.sqlite3")
    with pytest.raises(ValueError, match="databases differ"):
        CloudBackup(other.db_path, remote).restore()


def test_rolled_back_writes_do_not_advance_revision_or_signal_save(tmp_path):
    storage, _, backup = setup_backup(tmp_path)
    assert backup.save_once()
    called = []
    storage.on_commit = lambda: called.append(True)
    with pytest.raises(RuntimeError):
        with storage.transaction():
            storage.create_session("discarded", None, "now", {})
            raise RuntimeError("rollback")
    assert called == []
    assert backup.status()["status"] == "saved"
    assert not storage.session_exists("discarded", None)


def test_worker_retries_without_additional_writes(tmp_path):
    storage, remote, backup = setup_backup(tmp_path)
    backup.interval = 0.01
    uploaded = threading.Event()
    original = remote.upload
    attempts = []

    def flaky_upload(source, name):
        attempts.append(name)
        if len(attempts) == 1:
            raise OSError("temporary outage")
        original(source, name)

    remote.upload = flaky_upload
    original_prune = remote.prune

    def record_completed_save(keep):
        original_prune(keep)
        uploaded.set()

    remote.prune = record_completed_save
    backup.start(storage)
    try:
        assert uploaded.wait(timeout=3)
        assert backup.status()["status"] == "saved"
    finally:
        backup.close()


def test_snapshot_contains_committed_wal_data(tmp_path):
    storage, _, backup = setup_backup(tmp_path)
    with sqlite3.connect(storage.db_path) as open_connection:
        open_connection.execute("PRAGMA wal_autocheckpoint=0")
        storage.create_session("wal", None, "now", {})
        assert backup.save_once()
        restored = CloudBackup(tmp_path / "restored.sqlite3", backup.remote)
        restored.restore()
        assert PhraseStorage(restored.db_path).session_exists("wal", None)
