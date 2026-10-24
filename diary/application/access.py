from dataclasses import dataclass
from typing import Callable, ContextManager, Protocol

from pydantic import BaseModel, ConfigDict, Field, field_validator

from diary.application.errors import ApplicationError
from diary.domain.access import validate_login


SESSION_SECONDS = 30 * 24 * 60 * 60
PRE_SECONDS = 15 * 60


class Credentials(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    login: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=1024)

    @field_validator("login")
    @classmethod
    def normalize_login(cls, value: str) -> str:
        return validate_login(value)


class AccountRecord(BaseModel):
    login: str
    password_hash: str
    created_at: int


class SessionOutput(BaseModel):
    login: str


class SessionRecord(BaseModel):
    token_hash: str
    account_id: int = 1
    created_at: int
    expires_at: int


class LoginFailure(BaseModel):
    source_hash: str
    login_hash: str
    created_at: int


class TokenInput(BaseModel):
    token: str = ""


class CsrfInput(BaseModel):
    session_token: str | None = None
    pre_token: str = ""


class CheckCsrfInput(CsrfInput):
    supplied: str


class CsrfResult(BaseModel):
    csrf_token: str
    token: str
    new_pre: bool = False


class LoginCommand(CsrfInput):
    credentials: Credentials
    source: str


class LoginResult(BaseModel):
    login: str
    token: str
    csrf_token: str


class InvalidCredentials(ApplicationError):
    code = "invalid_credentials"

    def __init__(self) -> None:
        super().__init__("Неверный логин или пароль.")


class LoginLimited(ApplicationError):
    code = "login_limited"

    def __init__(self) -> None:
        super().__init__("Слишком много попыток. Попробуйте через 15 минут.")


class CsrfRejected(ApplicationError):
    code = "csrf"

    def __init__(self) -> None:
        super().__init__("Обновите страницу и повторите запрос.")


class AccessSecurity(Protocol):
    def digest(self, value: str) -> str: ...
    def new_token(self) -> str: ...
    def hash_password(self, password: str) -> str: ...
    def verify_password(self, password: str, hashed: str) -> bool: ...
    def csrf_token(self, token: str) -> str: ...
    def matches_csrf(self, token: str, supplied: str) -> bool: ...


class AccessStore(Protocol):
    def get_account(self) -> AccountRecord | None: ...
    def create_account(self, account: AccountRecord) -> None: ...
    def reset_password(self, hashed: str) -> None: ...
    def get_session(self, token_hash: str, now: int) -> SessionOutput | None: ...
    def add_session(self, session: SessionRecord) -> None: ...
    def delete_session(self, token_hash: str) -> None: ...
    def has_pre(self, token_hash: str, now: int) -> bool: ...
    def prune_pre(self, now: int) -> None: ...
    def add_pre(self, token_hash: str, expires_at: int) -> None: ...
    def delete_pre(self, token_hash: str) -> None: ...
    def prune_failures(self, before: int) -> None: ...
    def login_failures(self, source_hash: str, login_hash: str) -> list[LoginFailure]: ...
    def add_failure(self, failure: LoginFailure) -> None: ...


class AccessUow(Protocol):
    access: AccessStore

    def commit(self) -> None: ...


AccessUowFactory = Callable[[], ContextManager[AccessUow]]


@dataclass
class Login:
    uow: AccessUowFactory
    clock: Callable[[], int]
    security: AccessSecurity
    dummy_hash: str

    def execute(self, command: LoginCommand) -> LoginResult:
        now = self.clock()
        with self.uow() as uow:
            uow.access.prune_failures(now - PRE_SECONDS * 1000)
            source_hash = self.security.digest(command.source)
            login_hash = self.security.digest(command.credentials.login)
            attempts = uow.access.login_failures(source_hash, login_hash)
            blocked = any(sum(getattr(row, key) == value for row in attempts) >= 5
                          for key, value in (("source_hash", source_hash), ("login_hash", login_hash)))
            if blocked:
                uow.commit()
                raise LoginLimited()
            account = uow.access.get_account()
            valid = self.security.verify_password(command.credentials.password, account.password_hash if account else self.dummy_hash)
            if not account or command.credentials.login != account.login or not valid:
                uow.access.add_failure(LoginFailure(source_hash=source_hash, login_hash=login_hash, created_at=now))
                uow.commit()
                raise InvalidCredentials()
            token = self.security.new_token()
            if command.session_token:
                uow.access.delete_session(self.security.digest(command.session_token))
            uow.access.delete_pre(self.security.digest(command.pre_token))
            uow.access.add_session(SessionRecord(token_hash=self.security.digest(token), created_at=now,
                                                 expires_at=now + SESSION_SECONDS * 1000))
            uow.commit()
            return LoginResult(login=account.login, token=token, csrf_token=self.security.csrf_token(token))


@dataclass
class GetSession:
    uow: AccessUowFactory
    clock: Callable[[], int]
    security: AccessSecurity

    def execute(self, query: TokenInput) -> SessionOutput | None:
        if not query.token:
            return None
        with self.uow() as uow:
            return uow.access.get_session(self.security.digest(query.token), self.clock())


@dataclass
class Logout:
    uow: AccessUowFactory
    security: AccessSecurity

    def execute(self, command: TokenInput) -> None:
        with self.uow() as uow:
            uow.access.delete_session(self.security.digest(command.token))
            uow.commit()


@dataclass
class GetCsrf:
    uow: AccessUowFactory
    clock: Callable[[], int]
    security: AccessSecurity

    def execute(self, query: CsrfInput) -> CsrfResult:
        token = query.session_token
        new_pre = False
        if not token:
            token = query.pre_token
            now = self.clock()
            with self.uow() as uow:
                uow.access.prune_pre(now)
                if not token or not uow.access.has_pre(self.security.digest(token), now):
                    token = self.security.new_token()
                    uow.access.add_pre(self.security.digest(token), now + PRE_SECONDS * 1000)
                    new_pre = True
                uow.commit()
        return CsrfResult(csrf_token=self.security.csrf_token(token), token=token, new_pre=new_pre)


@dataclass
class CheckCsrf:
    uow: AccessUowFactory
    clock: Callable[[], int]
    security: AccessSecurity

    def execute(self, query: CheckCsrfInput) -> None:
        token = query.session_token or query.pre_token
        if not query.session_token:
            with self.uow() as uow:
                if not uow.access.has_pre(self.security.digest(token), self.clock()):
                    raise CsrfRejected()
        if not self.security.matches_csrf(token, query.supplied):
            raise CsrfRejected()
