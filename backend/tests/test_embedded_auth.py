from app.auth_cookies import EMBEDDED_AUTH_COOKIE_NAME, EMBEDDED_AUTH_HEADER

EMBEDDED = {EMBEDDED_AUTH_HEADER: "1"}
CREDENTIALS = {"username": "embedded_user", "password": "test-password"}


def test_embedded_register_login_and_logout(api):
    client, _ = api
    client.base_url = "https://testserver"
    response = client.post("/api/auth/register", json=CREDENTIALS, headers=EMBEDDED)
    assert response.status_code == 200
    cookie = response.headers["set-cookie"]
    for attribute in (
        EMBEDDED_AUTH_COOKIE_NAME,
        "HttpOnly",
        "Secure",
        "SameSite=none",
        "Partitioned",
        "Path=/",
    ):
        assert attribute in cookie
    assert "Domain=" not in cookie
    user = response.json()["user"]
    assert client.get("/api/auth/me", headers=EMBEDDED).json()["user"] == user
    assert client.get("/api/my/sessions", headers=EMBEDDED).is_success
    response = client.post("/api/auth/logout", headers=EMBEDDED)
    assert "Partitioned" in response.headers["set-cookie"]
    assert "Max-Age=0" in response.headers["set-cookie"]
    assert client.get("/api/auth/me", headers=EMBEDDED).json()["user"] is None
    assert client.post("/api/auth/login", json=CREDENTIALS, headers=EMBEDDED).is_success
    assert client.get("/api/auth/me", headers=EMBEDDED).json()["user"] == user


def test_embedded_cookie_does_not_authenticate_requests_without_custom_header(api):
    client, _ = api
    client.base_url = "https://testserver"
    guest = client.post("/api/session", json={}).json()["session_id"]
    client.post("/api/auth/register", json=CREDENTIALS, headers=EMBEDDED)
    assert client.get("/api/my/sessions").status_code == 401
    assert client.post(f"/api/my/sessions/{guest}/claim").status_code == 401
    assert client.post(f"/api/my/sessions/{guest}/claim", headers=EMBEDDED).is_success
    # All protected reads, including graph and export fetches, need the header.
    assert client.get(f"/api/sessions/{guest}/memory").status_code == 404
    assert client.get(f"/api/sessions/{guest}/memory", headers=EMBEDDED).is_success


def test_first_party_and_embedded_accounts_are_isolated(api):
    client, _ = api
    client.base_url = "https://testserver"
    direct = client.post(
        "/api/auth/register", json={**CREDENTIALS, "username": "direct_user"}
    )
    assert "SameSite=lax" in direct.headers["set-cookie"]
    assert "Partitioned" not in direct.headers["set-cookie"]
    embedded = client.post("/api/auth/register", json=CREDENTIALS, headers=EMBEDDED)
    assert client.get("/api/auth/me").json()["user"] == direct.json()["user"]
    assert (
        client.get("/api/auth/me", headers=EMBEDDED).json()["user"]
        == embedded.json()["user"]
    )
    client.post("/api/auth/logout", headers=EMBEDDED)
    assert client.get("/api/auth/me").json()["user"] == direct.json()["user"]
