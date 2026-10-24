import argparse
import getpass
import warnings
from dataclasses import dataclass
from pathlib import Path

from diary.application.admin import (
    AdminAction, CreateAccount, CreateAccountInput, MigrateDatabase, ResetPassword, ResetPasswordInput,
)
from diary.application.errors import ApplicationError


@dataclass
class AdminUseCases:
    create: CreateAccount
    reset: ResetPassword
    migrate: MigrateDatabase


def main() -> None:
    parser = argparse.ArgumentParser(description="Локальное управление доступом к дневнику")
    parser.add_argument("--database", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser(AdminAction.MIGRATE)
    create = commands.add_parser(AdminAction.CREATE_ACCOUNT)
    create.add_argument("--login", required=True)
    commands.add_parser(AdminAction.RESET_PASSWORD)
    args = parser.parse_args()
    action = AdminAction(args.command)
    from diary.bootstrap import admin_use_cases

    try:
        with admin_use_cases(args.database) as cases:
            if action == AdminAction.MIGRATE:
                cases.migrate.execute()
            else:
                # Refuse getpass's fallback that would echo secrets into redirected input.
                with warnings.catch_warnings():
                    warnings.simplefilter("error", getpass.GetPassWarning)
                    password = getpass.getpass("Новый пароль: ")
                    confirmation = getpass.getpass("Повторите пароль: ")
                if password != confirmation:
                    raise ValueError("Пароли не совпадают.")
                if action == AdminAction.CREATE_ACCOUNT:
                    cases.create.execute(CreateAccountInput(login=args.login, password=password))
                else:
                    cases.reset.execute(ResetPasswordInput(password=password))
    except ValueError as error:
        parser.exit(1, str(error) + "\n")
    except (getpass.GetPassWarning, EOFError):
        parser.exit(1, "Нужен интерактивный терминал со скрытым вводом пароля.\n")
    except ApplicationError:
        parser.exit(1, "Операция не сохранена. Проверьте миграции, доступ к БД и свободное место.\n")
    print("Готово.")
