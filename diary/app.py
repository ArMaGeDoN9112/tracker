import hmac
import os
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from starlette.concurrency import run_in_threadpool

from diary.db import database_engine
from diary.body_limit import BodyLimit
from diary.entries import register_entries
from diary.security import (
    PRE_COOKIE, PRE_SECONDS, SESSION_COOKIE, SESSION_SECONDS,
    csrf_token, digest, now_ms, password_hash, validate_login,
)


def failure(code: str, message: str, status: int, field: str | None = None) -> JSONResponse:
    return JSONResponse({"code": code, "message": message, "field": field}, status_code=status)


class Credentials(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    login: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=1024)

    @field_validator("login")
    @classmethod
    def normalize_login(cls, value: str) -> str:
        return validate_login(value)


def set_cookie(response: Response, name: str, value: str, seconds: int) -> None:
    response.set_cookie(name, value, max_age=seconds, secure=True, httponly=True, samesite="lax", path="/")


def clear_cookie(response: Response, name: str) -> None:
    response.delete_cookie(name, secure=True, httponly=True, samesite="lax", path="/")


def create_app(database: Path, origin: str) -> FastAPI:
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise ValueError("DIARY_ORIGIN должен быть HTTPS origin без пути и завершающего слеша.")
    engine = database_engine(database)
    dummy_hash = password_hash.hash(secrets.token_urlsafe(32))

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        with engine.connect() as connection:
            connection.execute(text("SELECT id FROM account LIMIT 1"))
        yield
        engine.dispose()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.add_middleware(BodyLimit)

    def authorize(request: Request) -> Response | None:
        if request.headers.get("host") != parsed.netloc:
            return failure("invalid_host", "Недопустимый адрес сервера.", 400)
        token = request.cookies.get(SESSION_COOKIE, "")
        with engine.connect() as connection:
            session = connection.execute(text(
                "SELECT account.login FROM session JOIN account ON account.id = session.account_id "
                "WHERE token_hash = :hash AND expires_at > :now"
            ), {"hash": digest(token), "now": now_ms()}).first() if token else None
            request.state.session_token = token if session else None
            request.state.login = session.login if session else None
            public = (request.method, request.url.path) in {
                ("GET", "/api/auth/csrf"), ("POST", "/api/auth/login"),
            }
            if not public and not session:
                return failure("unauthenticated", "Войдите в дневник.", 401)
            if request.method not in {"GET", "HEAD", "OPTIONS"}:
                if request.headers.get("origin") != origin:
                    return failure("csrf", "Обновите страницу и повторите запрос.", 403)
                csrf_source = token if session else request.cookies.get(PRE_COOKIE, "")
                if not session:
                    pre = connection.execute(text(
                        "SELECT token_hash FROM pre_session WHERE token_hash = :hash AND expires_at > :now"
                    ), {"hash": digest(csrf_source), "now": now_ms()}).first()
                    if not pre:
                        return failure("csrf", "Обновите страницу и повторите запрос.", 403)
                supplied = request.headers.get("x-csrf-token", "")
                if not hmac.compare_digest(supplied.encode(), csrf_token(csrf_source).encode()):
                    return failure("csrf", "Обновите страницу и повторите запрос.", 403)
        return None

    @app.middleware("http")
    async def access(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        try:
            rejected = await run_in_threadpool(authorize, request)
            response = rejected if rejected is not None else await call_next(request)
        except SQLAlchemyError:
            response = failure("unavailable", "Операция не сохранена. Повторите позже.", 503)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_input(request: Request, error: RequestValidationError) -> Response:
        # Pydantic's default errors include the submitted password.
        location = error.errors()[0]["loc"]
        field = str(location[-1]) if location and location[-1] != "body" else None
        message = "Проверьте введённые данные."
        if request.url.path == "/api/entries" or request.url.path.startswith("/api/entries/"):
            message = {
                "glucose": "Сахар: положительное число до 214748364,7; один знак после запятой, завершающие нули допустимы.",
                "bolus": "Подколка: число от 0 до 214748364,7; один знак после запятой, завершающие нули допустимы.",
                "comment": "Комментарий должен быть текстом до 10 000 символов.",
                "reason": "Выберите причину: еда, коррекция, еда и коррекция, либо оставьте пустой.",
                "occurred_at": "Укажите существующую дату RFC 3339 с явным смещением, с точностью до миллисекунд.",
                "operation_id": "UUID операции имеет неверный формат.",
                "expected_revision": "Укажите целую положительную ожидаемую редакцию записи.",
                None: "Укажите сахар, ненулевую подколку или комментарий.",
            }.get(field, message)
        return failure("validation", message, 422, field)

    @app.get("/api/auth/csrf")
    def csrf(request: Request) -> Response:
        token = request.state.session_token
        new_pre = False
        if not token:
            token = request.cookies.get(PRE_COOKIE, "")
            now = now_ms()
            with engine.begin() as connection:
                connection.execute(text("DELETE FROM pre_session WHERE expires_at <= :now"), {"now": now})
                existing = connection.execute(text("SELECT token_hash FROM pre_session WHERE token_hash = :hash"),
                                              {"hash": digest(token)}).first() if token else None
                if not existing:
                    token = secrets.token_urlsafe(32)
                    connection.execute(text("INSERT INTO pre_session VALUES (:hash, :expires)"),
                                       {"hash": digest(token), "expires": now + PRE_SECONDS * 1000})
                    new_pre = True
        response = JSONResponse({"csrf_token": csrf_token(token)})
        if new_pre:
            set_cookie(response, PRE_COOKIE, token, PRE_SECONDS)
        return response

    @app.post("/api/auth/login")
    def login(credentials: Credentials, request: Request) -> Response:
        now = now_ms()
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            connection.execute(text("DELETE FROM login_failure WHERE created_at <= :cutoff"),
                               {"cutoff": now - PRE_SECONDS * 1000})
            source_hash = digest(request.client.host if request.client else "unknown")
            login_hash = digest(credentials.login)
            attempts = connection.execute(text(
                "SELECT source_hash, login_hash, created_at FROM login_failure "
                "WHERE source_hash = :source OR login_hash = :login"
            ), {"source": source_hash, "login": login_hash}).all()
            blocked = any(sum(getattr(row, key) == value for row in attempts) >= 5
                          for key, value in (("source_hash", source_hash), ("login_hash", login_hash)))
            if blocked:
                response = failure("login_limited", "Слишком много попыток. Попробуйте через 15 минут.", 429)
                response.headers["Retry-After"] = "900"
                connection.commit()
                return response
            account = connection.execute(text("SELECT login, password_hash FROM account WHERE id = 1")).first()
            valid = password_hash.verify(credentials.password, account.password_hash if account else dummy_hash)
            if not account or credentials.login != account.login or not valid:
                connection.execute(text(
                    "INSERT INTO login_failure (source_hash, login_hash, created_at) VALUES (:source, :login, :now)"
                ), {"source": source_hash, "login": login_hash, "now": now})
                connection.commit()
                return failure("invalid_credentials", "Неверный логин или пароль.", 401)
            token = secrets.token_urlsafe(32)
            if request.state.session_token:
                connection.execute(text("DELETE FROM session WHERE token_hash = :hash"),
                                   {"hash": digest(request.state.session_token)})
            connection.execute(text("DELETE FROM pre_session WHERE token_hash = :hash"),
                               {"hash": digest(request.cookies.get(PRE_COOKIE, ""))})
            connection.execute(text("INSERT INTO session VALUES (:hash, 1, :now, :expires)"),
                               {"hash": digest(token), "now": now, "expires": now + SESSION_SECONDS * 1000})
            connection.commit()
        response = JSONResponse({"login": account.login, "csrf_token": csrf_token(token)})
        set_cookie(response, SESSION_COOKIE, token, SESSION_SECONDS)
        clear_cookie(response, PRE_COOKIE)
        return response

    @app.get("/api/auth/session")
    def session(request: Request) -> dict[str, str]:
        return {"login": str(request.state.login)}

    @app.post("/api/auth/logout", status_code=204)
    def logout(request: Request) -> Response:
        with engine.begin() as connection:
            connection.execute(text("DELETE FROM session WHERE token_hash = :hash"),
                               {"hash": digest(request.state.session_token)})
        response = Response(status_code=204)
        clear_cookie(response, SESSION_COOKIE)
        return response

    register_entries(app, engine)
    return app


def from_env() -> FastAPI:
    return create_app(Path(os.environ["DIARY_DATABASE"]), os.environ["DIARY_ORIGIN"])
