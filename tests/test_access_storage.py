import pytest
from sqlalchemy import event
from sqlalchemy.exc import SQLAlchemyError

from admin_setup import create_account
from diary.application.access import Credentials, GetSession, Login, LoginCommand, TokenInput
from diary.application.admin import ResetPassword, ResetPasswordInput
from diary.application.errors import Unavailable
from diary.infrastructure.database import database_engine, migrate
from diary.infrastructure.access import access_uow
from diary.infrastructure.security import CryptographicSecurity


@pytest.mark.parametrize("operation", ["reset", "login"])
@pytest.mark.parametrize("fault", ["statement", "commit"])
def test_storage_failure_rolls_back_password_or_session_rotation(tmp_path, operation, fault):
    database = tmp_path / "diary.sqlite3"
    migrate(database)
    create_account(database, "owner", "correct-password")
    engine = database_engine(database)
    security = CryptographicSecurity()
    writes = lambda: access_uow(engine, write=True)
    login = Login(writes, lambda: 100, security, "unused")
    command = LoginCommand(credentials=Credentials(login="owner", password="correct-password"), source="source")
    original = login.execute(command)

    def fail(connection, cursor, statement, parameters, context, executemany):
        prefix = "DELETE FROM session" if operation == "reset" else "INSERT INTO session"
        if statement.startswith(prefix):
            raise SQLAlchemyError("synthetic private storage detail")

    def fail_commit(connection):
        raise SQLAlchemyError("synthetic private storage detail")

    hook, listener = ("commit", fail_commit) if fault == "commit" else ("before_cursor_execute", fail)
    event.listen(engine, hook, listener)
    try:
        with pytest.raises(Unavailable) as error:
            if operation == "reset":
                ResetPassword(writes, security).execute(ResetPasswordInput(password="new-password-long"))
            else:
                login.execute(command.model_copy(update={"session_token": original.token}))
        assert isinstance(error.value.__cause__, SQLAlchemyError)
        assert "private storage" not in str(error.value)
    finally:
        event.remove(engine, hook, listener)
    try:
        session = GetSession(lambda: access_uow(engine), lambda: 101, security)
        assert session.execute(TokenInput(token=original.token)).login == "owner"
        assert login.execute(command).login == "owner"
    finally:
        engine.dispose()


def test_unrecognized_password_hash_is_safe_and_preserves_cause():
    from pwdlib.exceptions import UnknownHashError

    with pytest.raises(Unavailable) as error:
        CryptographicSecurity().verify_password("synthetic-password", "synthetic-private-hash")
    assert isinstance(error.value.__cause__, UnknownHashError)
    assert "synthetic" not in str(error.value)


@pytest.mark.parametrize("operation", ["hash", "token"])
def test_crypto_resource_errors_are_safe(monkeypatch, operation):
    from argon2.exceptions import HashingError

    def fail(*args):
        raise HashingError("private detail") if operation == "hash" else OSError("private detail")

    target = "diary.infrastructure.security.password_hash.hash" if operation == "hash" else "diary.infrastructure.security.secrets.token_urlsafe"
    monkeypatch.setattr(target, fail)
    security = CryptographicSecurity()
    with pytest.raises(Unavailable) as error:
        security.hash_password("synthetic-password") if operation == "hash" else security.new_token()
    assert error.value.__cause__ is not None
    assert "private detail" not in str(error.value)
