from pathlib import Path
from sqlite3 import Connection

from alembic import command
from alembic.config import Config
from alembic.util.exc import CommandError
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.exc import SQLAlchemyError

from diary.application.errors import Unavailable


def database_engine(path: Path) -> Engine:
    engine = create_engine("sqlite:///" + path.resolve().as_posix(), connect_args={"timeout": 10}, hide_parameters=True)

    @event.listens_for(engine, "connect")
    def configure(dbapi_connection: object, _: object) -> None:
        assert isinstance(dbapi_connection, Connection)
        dbapi_connection.execute("PRAGMA foreign_keys=ON")
        dbapi_connection.execute("PRAGMA synchronous=FULL")

    @event.listens_for(engine, "reset")
    def reset(dbapi_connection: object, _: object, reset_state: object) -> None:
        # Failed commit callbacks can leave SQLite active after SQLAlchemy ends its transaction.
        assert isinstance(dbapi_connection, Connection)
        dbapi_connection.rollback()

    return engine


def migrate(path: Path) -> None:
    engine = database_engine(path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        config = Config()
        config.set_main_option("script_location", str(Path(__file__).parents[2] / "migrations"))
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "head")
    except (SQLAlchemyError, OSError, CommandError) as error:
        raise Unavailable() from error
    finally:
        engine.dispose()
