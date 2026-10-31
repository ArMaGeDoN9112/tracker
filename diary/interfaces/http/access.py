from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import urlsplit

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from diary.application.access import (
    PRE_SECONDS, SESSION_SECONDS, CheckCsrf, CheckCsrfInput, Credentials,
    CsrfInput, GetCsrf, GetSession, Login, LoginCommand, Logout, SessionOutput, TokenInput,
)
from diary.application.errors import ApplicationError
from diary.interfaces.http.dto import CsrfOutput, LoginOutput
from diary.interfaces.http.errors import application_failure, failure


SESSION_COOKIE = "__Host-diary-session"
PRE_COOKIE = "__Host-diary-pre"


@dataclass
class AccessUseCases:
    login: Login
    logout: Logout
    session: GetSession
    csrf: GetCsrf
    check_csrf: CheckCsrf


def validate_origin(origin: str) -> str:
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username:
        raise ValueError("DIARY_ORIGIN должен быть HTTPS origin без пути и завершающего слеша.")
    return parsed.netloc


def set_cookie(response: Response, name: str, value: str, seconds: int) -> None:
    response.set_cookie(name, value, max_age=seconds, secure=True, httponly=True, samesite="lax", path="/")


def clear_cookie(response: Response, name: str) -> None:
    response.delete_cookie(name, secure=True, httponly=True, samesite="lax", path="/")


def register_access(app: FastAPI, cases: AccessUseCases, origin: str, additional_origins: tuple[str, ...] = ()) -> None:
    host = validate_origin(origin)
    allowed_origins = {origin, *additional_origins}

    def authorize(request: Request) -> Response | None:
        if request.headers.get("host") != host:
            return failure("invalid_host", "Недопустимый адрес сервера.", 400)
        token = request.cookies.get(SESSION_COOKIE, "")
        session = cases.session.execute(TokenInput(token=token))
        request.state.session_token = token if session else None
        request.state.login = session.login if session else None
        public = (request.method, request.url.path) in {
            ("GET", "/api/auth/csrf"), ("POST", "/api/auth/login"),
        }
        if not public and not session:
            return failure("unauthenticated", "Войдите в дневник.", 401)
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            if request.headers.get("origin") not in allowed_origins:
                return failure("csrf", "Обновите страницу и повторите запрос.", 403)
            cases.check_csrf.execute(CheckCsrfInput(
                session_token=request.state.session_token, pre_token=request.cookies.get(PRE_COOKIE, ""),
                supplied=request.headers.get("x-csrf-token", ""),
            ))
        return None

    @app.middleware("http")
    async def access(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        try:
            rejected = await run_in_threadpool(authorize, request)
            response = rejected if rejected is not None else await call_next(request)
        except ApplicationError as error:
            response = application_failure(error)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/api/auth/csrf")
    def csrf(request: Request) -> Response:
        result = cases.csrf.execute(CsrfInput(
            session_token=request.state.session_token, pre_token=request.cookies.get(PRE_COOKIE, ""),
        ))
        response = JSONResponse(CsrfOutput(csrf_token=result.csrf_token).model_dump(mode="json"))
        if result.new_pre:
            set_cookie(response, PRE_COOKIE, result.token, PRE_SECONDS)
        return response

    @app.post("/api/auth/login")
    def login(credentials: Credentials, request: Request) -> Response:
        result = cases.login.execute(LoginCommand(
            credentials=credentials, source=request.client.host if request.client else "unknown",
            session_token=request.state.session_token, pre_token=request.cookies.get(PRE_COOKIE, ""),
        ))
        response = JSONResponse(LoginOutput(login=result.login, csrf_token=result.csrf_token).model_dump(mode="json"))
        set_cookie(response, SESSION_COOKIE, result.token, SESSION_SECONDS)
        clear_cookie(response, PRE_COOKIE)
        return response

    @app.get("/api/auth/session")
    def session(request: Request) -> SessionOutput:
        return SessionOutput(login=str(request.state.login))

    @app.post("/api/auth/logout", status_code=204)
    def logout(request: Request) -> Response:
        cases.logout.execute(TokenInput(token=request.state.session_token))
        response = Response(status_code=204)
        clear_cookie(response, SESSION_COOKIE)
        return response
