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


def validate_password(password: str) -> None:
    if not 15 <= len(password) <= 1024:
        raise ValueError("Пароль должен содержать от 15 до 1024 символов.")


def validate_login(login: str) -> str:
    login = login.strip()
    if not 1 <= len(login) <= 128:
        raise ValueError("Логин должен содержать от 1 до 128 символов.")
    return login
