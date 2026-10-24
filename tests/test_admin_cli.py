import os
import pty
import select
import subprocess
import sys
import time

from fastapi.testclient import TestClient

from diary.app import create_app
from test_access import ORIGIN, PASSWORD, login


def admin(database, *args, passwords=()):
    master, slave = pty.openpty()
    try:
        with subprocess.Popen([sys.executable, '-m', 'diary.admin', '--database', str(database), *args],
                              stdin=slave, stdout=slave, stderr=slave, start_new_session=True) as process:
            output = b''
            deadline = time.monotonic() + 15
            try:
                for password in passwords:
                    prompt = output.count(b': ')
                    while output.count(b': ') == prompt:
                        assert time.monotonic() < deadline, output.decode()
                        if select.select([master], [], [], 0.1)[0]:
                            output += os.read(master, 65536)
                    os.write(master, (password + '\n').encode())
                while process.poll() is None:
                    assert time.monotonic() < deadline, output.decode()
                    if select.select([master], [], [], 0.1)[0]:
                        output += os.read(master, 65536)
                while select.select([master], [], [], 0)[0]:
                    output += os.read(master, 65536)
            finally:
                if process.poll() is None:
                    process.kill()
            return process.returncode, output.decode()
    finally:
        os.close(master)
        os.close(slave)


def test_admin_commands_preserve_access_and_revoke_sessions(tmp_path):
    database = tmp_path / 'diary.sqlite3'
    for _ in range(2):
        code, output = admin(database, 'migrate')
        assert code == 0
        assert output.endswith('Готово.\r\n')
    code, output = admin(database, 'create-account', '--login', 'owner', passwords=(PASSWORD, PASSWORD))
    assert code == 0
    assert PASSWORD not in output
    assert output.endswith('Готово.\r\n')
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        assert login(client).status_code == 200
        code, output = admin(database, 'reset-password', passwords=(PASSWORD, PASSWORD + '-different'))
        assert code == 1
        assert output.endswith('Пароли не совпадают.\r\n')
        assert PASSWORD not in output
        assert client.get('/api/auth/session').status_code == 200
        code, output = admin(database, 'reset-password', passwords=(PASSWORD + '-new', PASSWORD + '-new'))
        assert code == 0
        assert PASSWORD not in output
        assert client.get('/api/auth/session').status_code == 401
        assert login(client).status_code == 401
        assert login(client, PASSWORD + '-new').status_code == 200


def test_admin_refuses_password_input_without_terminal(tmp_path):
    result = subprocess.run([sys.executable, '-m', 'diary.admin', '--database', str(tmp_path / 'unused.sqlite3'),
                             'create-account', '--login', 'owner'], input=PASSWORD + '\n' + PASSWORD + '\n',
                            capture_output=True, text=True, timeout=15, start_new_session=True)
    assert result.returncode == 1
    assert result.stderr.endswith('Нужен интерактивный терминал со скрытым вводом пароля.\n')
    assert PASSWORD not in result.stdout + result.stderr
    assert not (tmp_path / 'unused.sqlite3').exists()


def test_admin_storage_errors_do_not_disclose_details(tmp_path):
    database = tmp_path / 'unmigrated.sqlite3'
    code, output = admin(database, 'create-account', '--login', 'owner', passwords=(PASSWORD, PASSWORD))
    assert code == 1
    assert output.endswith('Операция не сохранена. Проверьте миграции, доступ к БД и свободное место.\r\n')
    assert PASSWORD not in output
    assert 'Traceback' not in output
    assert 'INSERT' not in output


def test_admin_migration_failure_is_safe(tmp_path):
    parent = tmp_path / 'existing-file'
    parent.write_text('synthetic data')
    result = subprocess.run([sys.executable, '-m', 'diary.admin', '--database', str(parent / 'diary.sqlite3'),
                             'migrate'], capture_output=True, text=True, timeout=15)
    assert result.returncode == 1
    assert result.stderr == 'Операция не сохранена. Проверьте миграции, доступ к БД и свободное место.\n'
    assert parent.read_text() == 'synthetic data'
