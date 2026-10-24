from contextlib import contextmanager
from copy import deepcopy

import pytest

from diary.application.access import (
    AccountRecord, CheckCsrf, CheckCsrfInput, Credentials, CsrfInput, CsrfRejected,
    GetCsrf, GetSession, InvalidCredentials, Login, LoginCommand, LoginFailure,
    LoginLimited, Logout, SessionOutput, SessionRecord, TokenInput,
)
from diary.application.admin import (
    AccountError, CreateAccount, CreateAccountInput, MigrateDatabase, ResetPassword, ResetPasswordInput,
)


class MemoryAccess:
    def __init__(self):
        self.account = AccountRecord(login="owner", password_hash="hashed:correct-password", created_at=1)
        self.failures = []
        self.sessions = {}
        self.pre = {}

    def get_account(self):
        return self.account

    def prune_failures(self, before):
        self.failures = [row for row in self.failures if row.created_at > before]

    def login_failures(self, source_hash, login_hash):
        return [row for row in self.failures if row.source_hash == source_hash or row.login_hash == login_hash]

    def add_failure(self, failure):
        self.failures.append(failure)

    def create_account(self, record):
        self.account = record

    def reset_password(self, hashed):
        self.account.password_hash = hashed
        self.sessions.clear()

    def get_session(self, token_hash, now):
        record = self.sessions.get(token_hash)
        return SessionOutput(login=self.account.login) if record and record.expires_at > now else None

    def add_session(self, record):
        self.sessions[record.token_hash] = record

    def delete_session(self, token_hash):
        self.sessions.pop(token_hash, None)

    def has_pre(self, token_hash, now):
        return self.pre.get(token_hash, 0) > now

    def prune_pre(self, now):
        self.pre = {token: expires for token, expires in self.pre.items() if expires > now}

    def add_pre(self, token_hash, expires_at):
        self.pre[token_hash] = expires_at

    def delete_pre(self, token_hash):
        self.pre.pop(token_hash, None)


class MemoryUow:
    def __init__(self):
        self.saved = MemoryAccess()

    @contextmanager
    def open(self):
        self.access = deepcopy(self.saved)
        yield self

    def commit(self):
        self.saved = deepcopy(self.access)


class Security:
    def __init__(self):
        self.tokens = iter(("first-token", "second-token", "third-token"))

    def new_token(self):
        return next(self.tokens)

    def digest(self, value):
        return "digest:" + value

    def verify_password(self, password, hashed):
        return hashed == self.hash_password(password)

    def hash_password(self, password):
        return "hashed:" + password

    def csrf_token(self, token):
        return "csrf:" + token

    def matches_csrf(self, token, supplied):
        return supplied == self.csrf_token(token)


def test_failed_login_commits_attempts_and_limited_login_commits_cleanup():
    uow = MemoryUow()
    clock = 1_000_000
    case = Login(uow.open, lambda: clock, Security(), "dummy-hash")
    command = LoginCommand(credentials=Credentials(login="owner", password="wrong"), source="source")
    for _ in range(5):
        with pytest.raises(InvalidCredentials):
            case.execute(command)
    uow.saved.failures.append(LoginFailure(source_hash="old-source", login_hash="old-login", created_at=1))
    with pytest.raises(LoginLimited):
        case.execute(command)
    assert len(uow.saved.failures) == 5
    clock += 900_000
    with pytest.raises(InvalidCredentials):
        case.execute(command)
    assert len(uow.saved.failures) == 1


def test_login_rotates_only_current_session_and_consumes_pre_session():
    uow = MemoryUow()
    security = Security()
    clock = 1_000_000
    login = Login(uow.open, lambda: clock, security, "dummy")
    session = GetSession(uow.open, lambda: clock, security)
    command = LoginCommand(credentials=Credentials(login=" owner ", password="correct-password"), source="source")
    first = login.execute(command)
    second = login.execute(command)
    uow.saved.pre["digest:pre"] = clock + 1000
    third = login.execute(command.model_copy(update={"session_token": first.token, "pre_token": "pre"}))
    assert third.login == "owner"
    assert third.csrf_token == "csrf:third-token"
    assert session.execute(TokenInput(token=first.token)) is None
    assert session.execute(TokenInput(token=second.token)).login == "owner"
    assert not uow.saved.pre
    assert uow.saved.sessions["digest:third-token"].expires_at == 2_593_000_000
    logout = Logout(uow.open, security)
    logout.execute(TokenInput(token=third.token))
    assert session.execute(TokenInput(token=third.token)) is None
    clock = 2_592_999_999
    assert session.execute(TokenInput(token=second.token)).login == "owner"
    clock += 1
    assert session.execute(TokenInput(token=second.token)) is None


def test_csrf_reuses_pre_session_and_rejects_exact_expiry_and_wrong_token():
    uow = MemoryUow()
    security = Security()
    clock = 1_000_000
    get = GetCsrf(uow.open, lambda: clock, security)
    check = CheckCsrf(uow.open, lambda: clock, security)
    first = get.execute(CsrfInput())
    assert first.new_pre
    assert first.csrf_token == "csrf:first-token"
    reused = get.execute(CsrfInput(pre_token=first.token))
    assert not reused.new_pre
    assert reused.token == first.token
    query = CheckCsrfInput(pre_token=first.token, supplied=first.csrf_token)
    check.execute(query)
    with pytest.raises(CsrfRejected):
        check.execute(query.model_copy(update={"supplied": "wrong"}))
    clock += 900_000
    with pytest.raises(CsrfRejected):
        check.execute(query)
    renewed = get.execute(CsrfInput(pre_token=first.token))
    assert renewed.new_pre
    assert renewed.token == "second-token"
    assert "digest:first-token" not in uow.saved.pre
    authenticated = get.execute(CsrfInput(session_token="session"))
    assert authenticated.csrf_token == "csrf:session"
    assert not authenticated.new_pre
    check.execute(CheckCsrfInput(session_token="session", supplied="csrf:session"))


@pytest.mark.parametrize("missing,wrong_login", [(True, False), (False, True)])
def test_unknown_account_and_login_have_same_safe_error_and_record_attempt(missing, wrong_login):
    uow = MemoryUow()
    if missing:
        uow.saved.account = None
    verified = []

    class RecordingSecurity(Security):
        def verify_password(self, password, hashed):
            verified.append(hashed)
            return super().verify_password(password, hashed)

    case = Login(uow.open, lambda: 100, RecordingSecurity(), "dummy")
    with pytest.raises(InvalidCredentials, match="^Неверный логин или пароль.$"):
        case.execute(LoginCommand(credentials=Credentials(
            login="unknown" if wrong_login else "owner", password="correct-password"), source="source"))
    assert verified == ["dummy" if missing else "hashed:correct-password"]
    assert len(uow.saved.failures) == 1


def test_create_account_and_reset_password_use_ports_without_database():
    uow = MemoryUow()
    uow.saved.account = None
    security = Security()
    create = CreateAccount(uow.open, lambda: 123, security)
    reset = ResetPassword(uow.open, security)
    with pytest.raises(AccountError, match="Сначала создайте аккаунт"):
        reset.execute(ResetPasswordInput(password="new-password-long"))
    create.execute(CreateAccountInput(login=" owner ", password="correct-password"))
    assert uow.saved.account.created_at == 123
    with pytest.raises(AccountError, match="Аккаунт уже существует"):
        create.execute(CreateAccountInput(login="second", password="correct-password"))
    login = Login(uow.open, lambda: 200, security, "dummy")
    result = login.execute(LoginCommand(credentials=Credentials(login="owner", password="correct-password"), source="source"))
    reset.execute(ResetPasswordInput(password="new-password-long"))
    assert GetSession(uow.open, lambda: 200, security).execute(TokenInput(token=result.token)) is None
    with pytest.raises(InvalidCredentials):
        login.execute(LoginCommand(credentials=Credentials(login="owner", password="correct-password"), source="source"))
    assert login.execute(LoginCommand(credentials=Credentials(login="owner", password="new-password-long"), source="source")).login == "owner"


def test_migration_runs_through_injected_port():
    applied = []
    MigrateDatabase(lambda: applied.append("migration")).execute()
    assert applied == ["migration"]
