import json
import os
from pathlib import Path
import subprocess
import sys

from fastapi.testclient import TestClient

from admin_setup import create_account
from diary.app import create_app
from test_access import ORIGIN, PASSWORD, login


def start(database, tmp_path):
    stage = Path('Dockerfile').read_text().split('FROM python-base AS back\n', 1)[1].split('\nFROM ', 1)[0]
    command = json.loads(next(line[4:] for line in stage.splitlines() if line.startswith('CMD ')))
    executable = tmp_path / 'uvicorn'
    executable.write_text(f'#!{sys.executable}\n' + '''
import os
import sys
from pathlib import Path
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
sys.path.insert(0, os.getcwd())
from diary.infrastructure.database import database_engine

engine = database_engine(Path(os.environ['DIARY_DATABASE']))
try:
    with engine.connect() as connection:
        assert MigrationContext.configure(connection).get_current_revision() == ScriptDirectory('migrations').get_current_head()
finally:
    engine.dispose()
print('server-started')
''')
    executable.chmod(0o755)
    return subprocess.run(command, env={**os.environ, 'DIARY_DATABASE': str(database), 'PATH': f'{tmp_path}{os.pathsep}{os.environ["PATH"]}'}, capture_output=True, text=True, timeout=30)


def test_container_migrates_before_server_and_preserves_account_on_restart(tmp_path):
    database = tmp_path / 'database with spaces' / 'diary.sqlite3'
    result = start(database, tmp_path)
    assert result.returncode == 0, result.stderr
    assert 'server-started' in result.stdout
    create_account(database, 'owner', PASSWORD)
    result = start(database, tmp_path)
    assert result.returncode == 0, result.stderr
    assert 'server-started' in result.stdout
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        assert login(client).status_code == 200


def test_container_does_not_start_server_when_migration_fails(tmp_path):
    database = tmp_path / 'broken.sqlite3'
    database.write_text('invalid database')
    result = start(database, tmp_path)
    assert result.returncode != 0
    assert 'server-started' not in result.stdout
    assert database.read_text() == 'invalid database'
