from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, create_engine, event


def database_engine(path: Path) -> Engine:
    engine = create_engine("sqlite:///" + path.resolve().as_posix(), connect_args={"timeout": 10}, hide_parameters=True)

    @event.listens_for(engine, "connect")
    def configure(dbapi_connection: object, _: object) -> None:
        from sqlite3 import Connection

        assert isinstance(dbapi_connection, Connection)
        dbapi_connection.execute("PRAGMA foreign_keys=ON")
        dbapi_connection.execute("PRAGMA synchronous=FULL")

    return engine


def migrate(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    engine = database_engine(path)
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "head")
    finally:
        engine.dispose()
