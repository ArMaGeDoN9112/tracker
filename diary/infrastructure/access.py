from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass

from sqlalchemy import Connection, Engine, delete, insert, or_, select, update
from sqlalchemy.exc import SQLAlchemyError

from diary.application.access import (
    AccessStore, AccessUow, AccountRecord, LoginFailure, SessionOutput, SessionRecord,
)
from diary.application.errors import Unavailable
from diary.tables import account, login_failure, pre_session, session


@dataclass
class SqliteAccess:
    connection: Connection

    def get_account(self) -> AccountRecord | None:
        row = self.connection.execute(select(account).where(account.c.id == 1)).mappings().first()
        return AccountRecord.model_validate(row) if row is not None else None

    def create_account(self, record: AccountRecord) -> None:
        self.connection.execute(insert(account).values(id=1, **record.model_dump()))

    def reset_password(self, hashed: str) -> None:
        self.connection.execute(update(account).values(password_hash=hashed))
        self.connection.execute(delete(session))

    def get_session(self, token_hash: str, now: int) -> SessionOutput | None:
        row = self.connection.execute(select(account.c.login)
            .select_from(session.join(account, account.c.id == session.c.account_id))
            .where(session.c.token_hash == token_hash, session.c.expires_at > now)).mappings().first()
        return SessionOutput.model_validate(row) if row is not None else None

    def add_session(self, record: SessionRecord) -> None:
        self.connection.execute(insert(session).values(record.model_dump()))

    def delete_session(self, token_hash: str) -> None:
        self.connection.execute(delete(session).where(session.c.token_hash == token_hash))

    def has_pre(self, token_hash: str, now: int) -> bool:
        return self.connection.execute(select(pre_session.c.token_hash).where(
            pre_session.c.token_hash == token_hash, pre_session.c.expires_at > now)).first() is not None

    def prune_pre(self, now: int) -> None:
        self.connection.execute(delete(pre_session).where(pre_session.c.expires_at <= now))

    def add_pre(self, token_hash: str, expires_at: int) -> None:
        self.connection.execute(insert(pre_session).values(token_hash=token_hash, expires_at=expires_at))

    def delete_pre(self, token_hash: str) -> None:
        self.connection.execute(delete(pre_session).where(pre_session.c.token_hash == token_hash))

    def prune_failures(self, before: int) -> None:
        self.connection.execute(delete(login_failure).where(login_failure.c.created_at <= before))

    def login_failures(self, source_hash: str, login_hash: str) -> list[LoginFailure]:
        return [LoginFailure.model_validate(row) for row in self.connection.execute(select(login_failure).where(
            or_(login_failure.c.source_hash == source_hash, login_failure.c.login_hash == login_hash))).mappings()]

    def add_failure(self, failure: LoginFailure) -> None:
        self.connection.execute(insert(login_failure).values(failure.model_dump()))


class SqliteAccessUow:
    def __init__(self, connection: Connection) -> None:
        self.connection = connection
        self.access: AccessStore = SqliteAccess(connection)

    def commit(self) -> None:
        self.connection.commit()


@contextmanager
def access_uow(engine: Engine, *, write: bool = False) -> Generator[AccessUow]:
    try:
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE" if write else "BEGIN")
            yield SqliteAccessUow(connection)
    except SQLAlchemyError as error:
        raise Unavailable() from error


def check_access_database(engine: Engine) -> None:
    with access_uow(engine) as uow:
        uow.access.get_account()
