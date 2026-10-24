"""Disposable synthetic account for the browser acceptance check."""
from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn

from diary.application.admin import CreateAccountInput
from diary.app import create_app
from diary.bootstrap import admin_use_cases


def main() -> None:
    with TemporaryDirectory(prefix="diary-e2e-") as directory:
        database = Path(directory) / "diary.sqlite3"
        with admin_use_cases(database) as cases:
            cases.migrate.execute()
            cases.create.execute(CreateAccountInput(login="synthetic-owner", password="😀" * 600))
        uvicorn.run(create_app(database, "https://localhost:5173"), host="127.0.0.1", port=8000,
                    proxy_headers=False, access_log=False, log_level="warning")


if __name__ == "__main__":
    main()
