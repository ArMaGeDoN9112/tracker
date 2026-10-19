"""Disposable synthetic account for the browser acceptance check."""
from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn

from diary.admin import create_account
from diary.app import create_app
from diary.db import migrate


def main() -> None:
    with TemporaryDirectory(prefix="diary-e2e-") as directory:
        database = Path(directory) / "diary.sqlite3"
        migrate(database)
        create_account(database, "synthetic-owner", "😀" * 600)
        uvicorn.run(create_app(database, "https://localhost:5173"), host="127.0.0.1", port=8000,
                    proxy_headers=False, access_log=False, log_level="warning")


if __name__ == "__main__":
    main()
