import hashlib
import hmac
import secrets
import time

from pwdlib import PasswordHash
from pwdlib.exceptions import PwdlibError
from argon2.exceptions import HashingError

from diary.application.errors import Unavailable


password_hash = PasswordHash.recommended()


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def csrf_token(token: str) -> str:
    return digest("csrf:" + token)


class CryptographicSecurity:
    def digest(self, value: str) -> str:
        return digest(value)

    def new_token(self) -> str:
        try:
            return secrets.token_urlsafe(32)
        except OSError as error:
            raise Unavailable() from error

    def hash_password(self, password: str) -> str:
        try:
            return password_hash.hash(password)
        except HashingError as error:
            raise Unavailable() from error

    def verify_password(self, password: str, hashed: str) -> bool:
        try:
            return password_hash.verify(password, hashed)
        except PwdlibError as error:
            raise Unavailable() from error

    def csrf_token(self, token: str) -> str:
        return csrf_token(token)

    def matches_csrf(self, token: str, supplied: str) -> bool:
        return hmac.compare_digest(supplied.encode(), csrf_token(token).encode())
