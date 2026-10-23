import hashlib
import time

from pwdlib import PasswordHash


password_hash = PasswordHash.recommended()
SESSION_SECONDS = 30 * 24 * 60 * 60
PRE_SECONDS = 15 * 60
SESSION_COOKIE = "__Host-diary-session"
PRE_COOKIE = "__Host-diary-pre"


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def csrf_token(token: str) -> str:
    return digest("csrf:" + token)
