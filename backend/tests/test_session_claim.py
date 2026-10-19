from concurrent.futures import ThreadPoolExecutor

from app.schemas import CreateSessionRequest
from app.session_manager import SessionManager, UnknownSessionError
from app.storage import PhraseStorage


def test_claim_requires_login_and_becomes_private(api):
    client, main = api
    session_id = client.post("/api/session", json={}).json()["session_id"]
    url = f"/api/my/sessions/{session_id}/claim"
    assert client.post(url).status_code == 401
    client.post(
        "/api/auth/register", json={"username": "owner", "password": "test-password"}
    )
    assert client.post(url).status_code == 200
    assert client.post(url).status_code == 200
    assert client.get("/api/my/sessions").json()["items"][0]["session_id"] == session_id
    client.post("/api/auth/logout")
    assert client.get(f"/api/sessions/{session_id}/history").status_code == 404
    client.post(
        "/api/auth/register", json={"username": "other", "password": "test-password"}
    )
    assert client.post(url).status_code == 404
    # Access remains restricted after engine eviction and restoration.
    main.session_manager = SessionManager(main.storage)
    assert client.post(url).status_code == 404


def test_two_accounts_cannot_claim_the_same_guest_session(tmp_path):
    storage = PhraseStorage(tmp_path / "claims.sqlite3")
    manager = SessionManager(storage)
    session_id = manager.create_session(CreateSessionRequest(), None).session_id

    def claim(user_id):
        try:
            manager.claim_session(session_id, user_id)
            return user_id
        except UnknownSessionError:
            return None

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(claim, ["alice", "bob"]))
    assert len([result for result in results if result]) == 1
