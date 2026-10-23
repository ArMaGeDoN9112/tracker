import hmac
import os
import secrets
from collections.abc import AsyncGenerator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import delete, insert, or_, select
from sqlalchemy.exc import SQLAlchemyError
from starlette.concurrency import run_in_threadpool

from diary.db import database_engine
from diary.domain.access import validate_login
from diary.dto import CsrfOutput, ErrorOutput, LoginOutput, SessionOutput
from diary.bootstrap import register_diary_http, register_water_http
from diary.interfaces.http.errors import register_application_errors
from diary.body_limit import BodyLimit
from diary.glucose import register_glucose
from diary.bootstrap import register_nutrition_http
from diary.meals import register_nutrition_reads
from diary.export import register_export
from diary.backup import register_backup_status
from diary.security import (
    PRE_COOKIE, PRE_SECONDS, SESSION_COOKIE, SESSION_SECONDS,
    csrf_token, digest, now_ms, password_hash,
)
from diary.tables import account as account_table, login_failure, pre_session, session as session_table


def failure(code: str, message: str, status: int, field: str | None = None) -> JSONResponse:
    return JSONResponse(ErrorOutput(code=code, message=message, field=field).model_dump(mode="json"), status_code=status)


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
    async def lifespan(_: FastAPI) -> AsyncGenerator[None]:
        with engine.connect() as connection:
            connection.execute(select(account_table.c.id).limit(1))
        yield
        engine.dispose()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    register_application_errors(app)
    app.add_middleware(BodyLimit)

    def authorize(request: Request) -> Response | None:
        if request.headers.get("host") != parsed.netloc:
            return failure("invalid_host", "Недопустимый адрес сервера.", 400)
        token = request.cookies.get(SESSION_COOKIE, "")
        with engine.connect() as connection:
            session = connection.execute(select(account_table.c.login)
                .select_from(session_table.join(account_table, account_table.c.id == session_table.c.account_id))
                .where(session_table.c.token_hash == digest(token), session_table.c.expires_at > now_ms())).first() if token else None
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
                    pre = connection.execute(select(pre_session.c.token_hash).where(
                        pre_session.c.token_hash == digest(csrf_source), pre_session.c.expires_at > now_ms())).first()
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
        if request.url.path.startswith("/api/water"):
            field = ".".join(str(part) for part in location[1:]) or None
            name = str(location[1]) if len(location) > 1 else ""
            message = {
                "volume_ml": "Объём воды: целые мл от 1 до 2147483647.",
                "volumes_ml": "Кнопки: уникальные целые объёмы от 1 до 2147483647 мл; пустой набор допустим.",
                "occurred_at": "Укажите дату RFC 3339 с явным смещением и точностью до миллисекунд.",
            }.get(name, message)
        if request.url.path.startswith(("/api/products", "/api/meals")):
            field = ".".join(str(part) for part in location[1:]) or None
            leaf = str(location[-1]) if location else ""
            message = {
                "name": "Название: от 1 до 200 символов без крайних пробелов.",
                "photo": "Не удалось принять фото. Выберите изображение заново; миниатюра должна быть JPEG до 45 000 символов.",
                "unit": "Выберите основу 100 г или 100 мл.",
                "quantity": "Количество порции: положительное десятичное число до 21474836,47, точность до сотых.",
                "protein": "Белки: десятичная строка от 0 до 21474836,47, точность до сотых; пустое — неизвестно.",
                "fat": "Жиры: десятичная строка от 0 до 21474836,47, точность до сотых; пустое — неизвестно.",
                "carbohydrate": "Углеводы: десятичная строка от 0 до 21474836,47, точность до сотых; пустое — неизвестно.",
                "calories": "Калории: десятичная строка от 0 до 21474836,47, точность до сотых; пустое — неизвестно.",
                "id": "Укажите уникальный UUID порции.",
                "portions": "Проверьте список порций и уникальность их UUID.",
            }.get(leaf, message)
            if request.url.path.startswith("/api/meals"):
                message = {
                    "quantity": "Количество: положительное десятичное число до 21474836,47, точность до сотых.",
                    "basis_quantity": "Основа продукта — 100 г или 100 мл.",
                    "lines": "Добавьте хотя бы одну строку; UUID строк не должны повторяться.",
                    "occurred_at": "Укажите дату RFC 3339 с явным смещением и точностью до миллисекунд.",
                    "category": "Выберите завтрак, обед, ужин, перекус либо оставьте пустой.",
                    "id": "Укажите уникальный UUID строки или порции.",
                    "product_id": "Укажите UUID исходного продукта.",
                    "product_revision": "Укажите положительную редакцию исходного продукта.",
                }.get(leaf, message)
        if request.url.path == "/api/temporary-basals":
            message = {
                "starts_at": "Укажите существующую дату RFC 3339 с явным смещением, с точностью до миллисекунд.",
                "duration_minutes": "Длительность: целое число минут от 1 до 2147483647.",
                "percent": "Процент: целое число от 0 до 2147483647; 100% означает обычную скорость.",
                "operation_id": "UUID операции имеет неверный формат.",
                None: "Окончание временной базы за пределами календаря. Уменьшите начало или длительность.",
            }.get(field, message)
        if request.url.path == "/api/basal-schedules":
            message = {
                "starts_at": "Укажите существующую дату RFC 3339 с явным смещением, с точностью до миллисекунд.",
                "intervals": "Начните с 00:00; интервалы должны идти строго по возрастанию без повторов (до 23:59).",
                "minute": "Минута интервала должна быть целым числом от 0 до 1439.",
                "rate": "Скорость: число от 0 до 21474836,47 ед/ч; два знака после запятой, завершающие нули допустимы.",
                "operation_id": "UUID операции имеет неверный формат.",
                None: "Проверьте начало действия и полное расписание с 00:00.",
            }.get(field, message)
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
                connection.execute(delete(pre_session).where(pre_session.c.expires_at <= now))
                existing = connection.execute(select(pre_session.c.token_hash).where(pre_session.c.token_hash == digest(token))).first() if token else None
                if not existing:
                    token = secrets.token_urlsafe(32)
                    connection.execute(insert(pre_session).values(
                        token_hash=digest(token), expires_at=now + PRE_SECONDS * 1000))
                    new_pre = True
        response = JSONResponse(CsrfOutput(csrf_token=csrf_token(token)).model_dump(mode="json"))
        if new_pre:
            set_cookie(response, PRE_COOKIE, token, PRE_SECONDS)
        return response

    @app.post("/api/auth/login")
    def login(credentials: Credentials, request: Request) -> Response:
        now = now_ms()
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            connection.execute(delete(login_failure).where(login_failure.c.created_at <= now - PRE_SECONDS * 1000))
            source_hash = digest(request.client.host if request.client else "unknown")
            login_hash = digest(credentials.login)
            attempts = connection.execute(select(login_failure.c.source_hash, login_failure.c.login_hash, login_failure.c.created_at)
                .where(or_(login_failure.c.source_hash == source_hash, login_failure.c.login_hash == login_hash))).all()
            blocked = any(sum(getattr(row, key) == value for row in attempts) >= 5
                          for key, value in (("source_hash", source_hash), ("login_hash", login_hash)))
            if blocked:
                response = failure("login_limited", "Слишком много попыток. Попробуйте через 15 минут.", 429)
                response.headers["Retry-After"] = "900"
                connection.commit()
                return response
            account = connection.execute(select(account_table.c.login, account_table.c.password_hash).where(account_table.c.id == 1)).first()
            valid = password_hash.verify(credentials.password, account.password_hash if account else dummy_hash)
            if not account or credentials.login != account.login or not valid:
                connection.execute(insert(login_failure).values(source_hash=source_hash, login_hash=login_hash, created_at=now))
                connection.commit()
                return failure("invalid_credentials", "Неверный логин или пароль.", 401)
            token = secrets.token_urlsafe(32)
            if request.state.session_token:
                connection.execute(delete(session_table).where(session_table.c.token_hash == digest(request.state.session_token)))
            connection.execute(delete(pre_session).where(pre_session.c.token_hash == digest(request.cookies.get(PRE_COOKIE, ""))))
            connection.execute(insert(session_table).values(
                token_hash=digest(token), account_id=1, created_at=now, expires_at=now + SESSION_SECONDS * 1000))
            connection.commit()
        response = JSONResponse(LoginOutput(login=account.login, csrf_token=csrf_token(token)).model_dump(mode="json"))
        set_cookie(response, SESSION_COOKIE, token, SESSION_SECONDS)
        clear_cookie(response, PRE_COOKIE)
        return response

    @app.get("/api/auth/session")
    def session(request: Request) -> SessionOutput:
        return SessionOutput(login=str(request.state.login))

    @app.post("/api/auth/logout", status_code=204)
    def logout(request: Request) -> Response:
        with engine.begin() as connection:
            connection.execute(delete(session_table).where(session_table.c.token_hash == digest(request.state.session_token)))
        response = Response(status_code=204)
        clear_cookie(response, SESSION_COOKIE)
        return response

    register_diary_http(app, engine)
    register_nutrition_http(app, engine)
    register_nutrition_reads(app, engine)
    register_water_http(app, engine)
    register_glucose(app, engine)
    register_export(app, engine)
    register_backup_status(app, database)
    return app


def from_env() -> FastAPI:
    return create_app(Path(os.environ["DIARY_DATABASE"]), os.environ["DIARY_ORIGIN"])
