from pathlib import Path

from diary.application.admin import CreateAccountInput, ResetPasswordInput
from diary.bootstrap import admin_use_cases
from diary.interfaces.cli.admin import main


def create_account(database: Path, login: str, password: str) -> None:
    with admin_use_cases(database) as cases:
        cases.create.execute(CreateAccountInput(login=login, password=password))


def reset_password(database: Path, password: str) -> None:
    with admin_use_cases(database) as cases:
        cases.reset.execute(ResetPasswordInput(password=password))


if __name__ == "__main__":
    main()
