from dataclasses import dataclass
from enum import StrEnum
from typing import Callable

from pydantic import BaseModel

from diary.application.access import AccessSecurity, AccessUowFactory, AccountRecord
from diary.application.errors import ApplicationError
from diary.domain.access import validate_login, validate_password


class AdminAction(StrEnum):
    MIGRATE = "migrate"
    CREATE_ACCOUNT = "create-account"
    RESET_PASSWORD = "reset-password"


class CreateAccountInput(BaseModel):
    login: str
    password: str


class ResetPasswordInput(BaseModel):
    password: str


class AccountError(ApplicationError, ValueError):
    code = "account"


@dataclass
class CreateAccount:
    uow: AccessUowFactory
    clock: Callable[[], int]
    security: AccessSecurity

    def execute(self, command: CreateAccountInput) -> None:
        try:
            login = validate_login(command.login)
            validate_password(command.password)
        except ValueError as error:
            raise AccountError(str(error)) from error
        hashed = self.security.hash_password(command.password)
        with self.uow() as uow:
            if uow.access.get_account() is not None:
                raise AccountError("Аккаунт уже существует.")
            uow.access.create_account(AccountRecord(login=login, password_hash=hashed, created_at=self.clock()))
            uow.commit()


@dataclass
class ResetPassword:
    uow: AccessUowFactory
    security: AccessSecurity

    def execute(self, command: ResetPasswordInput) -> None:
        try:
            validate_password(command.password)
        except ValueError as error:
            raise AccountError(str(error)) from error
        hashed = self.security.hash_password(command.password)
        with self.uow() as uow:
            if uow.access.get_account() is None:
                raise AccountError("Сначала создайте аккаунт.")
            uow.access.reset_password(hashed)
            uow.commit()


@dataclass
class MigrateDatabase:
    migrate: Callable[[], None]

    def execute(self) -> None:
        self.migrate()
