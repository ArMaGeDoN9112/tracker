import argparse
import getpass
import warnings
from pathlib import Path

from sqlalchemy import delete, insert, select, update
from sqlalchemy.exc import SQLAlchemyError

from diary.db import database_engine, migrate
from diary.security import now_ms, password_hash, validate_login, validate_password
from diary.tables import account, session


def create_account(database: Path, login: str, password: str) -> None:
    login = validate_login(login)
    validate_password(password)
    hashed = password_hash.hash(password)
    engine = database_engine(database)
    try:
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            if connection.execute(select(account.c.id)).first():
                raise ValueError("Аккаунт уже существует.")
            connection.execute(insert(account).values(id=1, login=login, password_hash=hashed, created_at=now_ms()))
            connection.commit()
    finally:
        engine.dispose()


def reset_password(database: Path, password: str) -> None:
    validate_password(password)
    hashed = password_hash.hash(password)
    engine = database_engine(database)
    try:
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            if not connection.execute(select(account.c.id)).first():
                raise ValueError("Сначала создайте аккаунт.")
            connection.execute(update(account).values(password_hash=hashed))
            connection.execute(delete(session))
            connection.commit()
    finally:
        engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="Локальное управление доступом к дневнику")
    parser.add_argument("--database", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("migrate")
    create = commands.add_parser("create-account")
    create.add_argument("--login", required=True)
    commands.add_parser("reset-password")
    args = parser.parse_args()
    try:
        if args.command == "migrate":
            migrate(args.database)
        else:
            # Refuse getpass's fallback that would echo secrets into redirected input.
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                password = getpass.getpass("Новый пароль: ")
                confirmation = getpass.getpass("Повторите пароль: ")
            if password != confirmation:
                raise ValueError("Пароли не совпадают.")
            if args.command == "create-account":
                create_account(args.database, args.login, password)
            else:
                reset_password(args.database, password)
    except ValueError as error:
        parser.exit(1, str(error) + "\n")
    except (getpass.GetPassWarning, EOFError):
        parser.exit(1, "Нужен интерактивный терминал со скрытым вводом пароля.\n")
    except SQLAlchemyError:
        parser.exit(1, "Операция не сохранена. Проверьте миграции, доступ к БД и свободное место.\n")
    print("Готово.")


if __name__ == "__main__":
    main()
