from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import hashlib
import hmac
import secrets
import uuid

from .storage import PhraseStorage


AUTH_COOKIE_NAME = "continuator_auth"
AUTH_TOKEN_MAX_AGE_SECONDS = 60 * 60 * 24 * 30


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class AuthenticatedUser:
    id: str
    username: str
    created_at: str


class AuthenticationError(ValueError):
    """Raised when the provided credentials or token are invalid."""


class UsernameTakenError(ValueError):
    """Raised when a username is already registered."""


class AuthManager:
    def __init__(self, storage: PhraseStorage) -> None:
        self.storage = storage

    def register(self, username: str, password: str) -> tuple[AuthenticatedUser, str]:
        prepared_username = self._prepare_username(username)
        existing_user = self.storage.get_user_by_username(prepared_username.casefold())
        if existing_user is not None:
            raise UsernameTakenError(prepared_username)

        created_at = utc_now_iso()
        user_id = uuid.uuid4().hex
        salt = secrets.token_bytes(16)
        password_hash = self._hash_password(password, salt)
        self.storage.create_user(
            user_id=user_id,
            username=prepared_username,
            username_normalized=prepared_username.casefold(),
            password_hash=password_hash,
            password_salt=salt.hex(),
            created_at=created_at,
        )
        user = AuthenticatedUser(id=user_id, username=prepared_username, created_at=created_at)
        return user, self._issue_token(user_id)

    def login(self, username: str, password: str) -> tuple[AuthenticatedUser, str]:
        prepared_username = self._prepare_username(username)
        user_record = self.storage.get_user_by_username(prepared_username.casefold())
        if user_record is None:
            raise AuthenticationError("Invalid username or password.")

        expected_hash = str(user_record["password_hash"])
        salt = bytes.fromhex(str(user_record["password_salt"]))
        password_hash = self._hash_password(password, salt)
        if not hmac.compare_digest(password_hash, expected_hash):
            raise AuthenticationError("Invalid username or password.")

        user = AuthenticatedUser(
            id=str(user_record["id"]),
            username=str(user_record["username"]),
            created_at=str(user_record["created_at"]),
        )
        return user, self._issue_token(user.id)

    def get_user_from_token(self, raw_token: str | None) -> AuthenticatedUser | None:
        if not raw_token:
            return None

        token_hash = self._hash_token(raw_token)
        user_record = self.storage.get_user_for_token(token_hash, utc_now_iso())
        if user_record is None:
            self.storage.delete_auth_token(token_hash)
            return None

        return AuthenticatedUser(
            id=str(user_record["id"]),
            username=str(user_record["username"]),
            created_at=str(user_record["created_at"]),
        )

    def logout(self, raw_token: str | None) -> None:
        if not raw_token:
            return
        self.storage.delete_auth_token(self._hash_token(raw_token))

    def _issue_token(self, user_id: str) -> str:
        created_at = utc_now_iso()
        expires_at = (
            datetime.now(UTC) + timedelta(seconds=AUTH_TOKEN_MAX_AGE_SECONDS)
        ).isoformat(timespec="seconds").replace("+00:00", "Z")
        raw_token = secrets.token_urlsafe(32)
        self.storage.create_auth_token(
            token_hash=self._hash_token(raw_token),
            user_id=user_id,
            created_at=created_at,
            expires_at=expires_at,
        )
        return raw_token

    def _prepare_username(self, username: str) -> str:
        return username.strip()

    def _hash_password(self, password: str, salt: bytes) -> str:
        return hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=2**14,
            r=8,
            p=1,
            dklen=64,
        ).hex()

    def _hash_token(self, raw_token: str) -> str:
        return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


__all__ = [
    "AUTH_COOKIE_NAME",
    "AUTH_TOKEN_MAX_AGE_SECONDS",
    "AuthenticatedUser",
    "AuthenticationError",
    "AuthManager",
    "UsernameTakenError",
]
