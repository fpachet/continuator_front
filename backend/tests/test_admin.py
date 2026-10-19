from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import hashlib
import json

import pytest

from app.auth import AuthenticationError, AuthManager
from app.cloud_backup import CloudBackup
from app.storage import PhraseStorage
from app.schemas import CreateSessionRequest
from .test_cloud_backup import FakeBucket

PASSWORD = "initial-password"
NEW_PASSWORD = "a-new-test-password"


def register(client, username):
    response = client.post(
        "/api/auth/register", json={"username": username, "password": PASSWORD}
    )
    assert response.is_success, response.text
    return response.json()["user"]


@pytest.fixture
def administrator(api):
    client, main = api
    user = register(client, "owner")
    main.settings = replace(main.settings, admin_user_ids=frozenset([user["id"]]))
    return client, main, user


def create_reset(client, user_id, password=PASSWORD):
    return client.post(
        f"/api/admin/users/{user_id}/password-reset", json={"admin_password": password}
    )


def complete_reset(client, token, password=NEW_PASSWORD):
    return client.post(
        "/api/auth/reset-password",
        json={"token": token, "password": password, "confirm_password": password},
    )


def test_admin_access_requires_authentication_and_explicit_account_id(api):
    client, _ = api
    paths = [
        "/api/admin/overview",
        "/api/admin/users",
        "/api/admin/activity",
        "/api/admin/users/unknown",
    ]
    for path in paths:
        assert client.get(path).status_code == 401
    assert create_reset(client, "unknown").status_code == 401
    register(client, "fpachet")
    for path in paths:
        assert client.get(path).status_code == 403
    assert create_reset(client, "unknown").status_code == 403
    assert client.get("/api/auth/me").json()["user"]["is_admin"] is False


def test_usage_summary_user_filter_and_no_credentials_leak(administrator, phrase):
    client, main, owner = administrator
    guest = main.session_manager.create_session(CreateSessionRequest(), None)
    owned = client.post("/api/session", json={"transposition": False}).json()[
        "session_id"
    ]
    response = client.post(
        "/api/continue",
        json={"session_id": owned, "phrase": [event.model_dump() for event in phrase]},
    )
    assert response.is_success
    summary = client.get("/api/admin/overview").json()
    assert summary == {
        "registered_users": 1,
        "total_sessions": 2,
        "guest_sessions": 1,
        "input_phrases": 1,
        "generated_phrases": 1,
        "guest_phrases": 0,
    }
    users = client.get("/api/admin/users", params={"q": "OWN"}).json()
    assert users["total"] == 1
    user = users["items"][0]
    assert user["last_login_at"] is not None
    assert user["session_count"] == 1
    assert user["phrase_count"] == 2
    assert client.get("/api/admin/users?q=missing").json()["total"] == 0
    detail = client.get(f"/api/admin/users/{owner['id']}").json()
    assert [session["id"] for session in detail["sessions"]] == [owned]
    assert detail["sessions"][0]["memory_variant_count"] == 1
    assert {item["event_type"] for item in detail["activity"]} >= {
        "account_registered",
        "signed_in",
        "phrase_input",
        "phrase_generated",
        "session_created",
    }
    all_activity = client.get("/api/admin/activity").json()["items"]
    assert any(
        item["session_id"] == guest.session_id and item["username"] is None
        for item in all_activity
    )
    serialized = json.dumps({"users": users, "detail": detail})
    assert not any(
        secret in serialized
        for secret in ("password_hash", "password_salt", "token_hash", PASSWORD)
    )
    assert client.get("/api/admin/users/unknown").status_code == 404
    assert client.get("/api/auth/me").json()["user"]["is_admin"] is True
    assert client.get("/api/admin/users").headers["cache-control"] == "no-store"


def test_reset_requires_admin_password_and_changes_nothing_until_used(administrator):
    client, main, owner = administrator
    user, old_token = main.auth_manager.register("musician", PASSWORD)
    assert create_reset(client, user.id, "wrong-password").status_code == 403
    assert create_reset(client, "unknown").status_code == 404
    response = create_reset(client, user.id)
    assert response.is_success
    token = response.json()["token"]
    assert len(token) >= 32
    assert main.auth_manager.get_user_from_token(old_token).id == user.id
    assert main.auth_manager.verify_password("musician", PASSWORD).id == user.id
    with main.storage._connect() as connection:
        row = dict(
            connection.execute(
                "SELECT * FROM password_reset_tokens WHERE user_id = ?", (user.id,)
            ).fetchone()
        )
    assert row["token_hash"] == hashlib.sha256(token.encode()).hexdigest()
    assert token not in json.dumps(row)
    response = complete_reset(client, token)
    assert response.is_success
    assert main.auth_manager.get_user_from_token(old_token) is None
    with pytest.raises(AuthenticationError):
        main.auth_manager.login("musician", PASSWORD)
    assert main.auth_manager.login("musician", NEW_PASSWORD)[0].id == user.id
    assert complete_reset(client, token).status_code == 400
    assert client.get("/api/auth/me").json()["user"]["id"] == owner["id"]


def test_reset_expiry_reissue_validation_and_user_data_preservation(administrator):
    client, main, _ = administrator
    user, _ = main.auth_manager.register("musician", PASSWORD)
    session = main.session_manager.create_session(CreateSessionRequest(), user.id)
    first = create_reset(client, user.id).json()["token"]
    second = create_reset(client, user.id).json()["token"]
    assert complete_reset(client, first).status_code == 400
    mismatch = client.post(
        "/api/auth/reset-password",
        json={
            "token": second,
            "password": NEW_PASSWORD,
            "confirm_password": "different-password",
        },
    )
    assert mismatch.status_code == 400
    assert complete_reset(client, second, "short").status_code == 422
    assert complete_reset(client, second).is_success
    assert (
        main.session_manager.list_user_sessions(user.id).items[0].session_id
        == session.session_id
    )
    expired = create_reset(client, user.id).json()["token"]
    with main.storage._connect() as connection:
        connection.execute(
            "UPDATE password_reset_tokens SET expires_at = '2000-01-01T00:00:00Z'"
        )
    assert complete_reset(client, expired).status_code == 400


def test_only_one_concurrent_reset_can_consume_a_link(administrator):
    client, main, _ = administrator
    user, _ = main.auth_manager.register("musician", PASSWORD)
    token = create_reset(client, user.id).json()["token"]

    def consume(index):
        try:
            main.auth_manager.reset_password(token, f"new-password-{index}")
            return True
        except AuthenticationError:
            return False

    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(consume, range(2))) == [False, True]


def test_reset_links_and_audit_survive_cloud_recovery(administrator, tmp_path):
    client, main, _ = administrator
    user, old_token = main.auth_manager.register("musician", PASSWORD)
    token = create_reset(client, user.id).json()["token"]
    remote = FakeBucket()
    backup = CloudBackup(main.storage.db_path, remote)
    backup.storage = main.storage
    assert backup.save_once()
    path = tmp_path / "restore.sqlite3"
    CloudBackup(path, remote).restore()
    restored_storage = PhraseStorage(path)
    restored = AuthManager(restored_storage)
    assert restored.get_user_from_token(old_token).id == user.id
    restored.reset_password(token, NEW_PASSWORD)
    assert restored.get_user_from_token(old_token) is None
    assert restored.login("musician", NEW_PASSWORD)[0].id == user.id
    with restored_storage._connect() as connection:
        events = [
            row[0]
            for row in connection.execute(
                "SELECT event_type FROM audit_events WHERE user_id = ?", (user.id,)
            )
        ]
    assert "reset_link_created" in events and "password_reset" in events


def test_reset_and_admin_pages_do_not_cache_or_leak_reset_capabilities(api):
    client, _ = api
    for path in ("/admin", "/reset-password"):
        response = client.get(path)
        assert response.is_success
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["referrer-policy"] == "no-referrer"
    assert (
        "frame-ancestors 'none'"
        in client.get("/reset-password").headers["content-security-policy"]
    )
