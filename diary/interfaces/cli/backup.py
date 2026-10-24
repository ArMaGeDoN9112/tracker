import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import time

from diary.application.backup import BackupAction, BackupCommand, BackupInput, BackupKind, RestoreInput


def main() -> None:
    os.umask(0o077)
    os.environ["TZ"] = "Europe/Moscow"
    time.tzset()
    parser = argparse.ArgumentParser(description="Зашифрованные копии дневника (restic)")
    parser.add_argument("--database", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("backup")
    create.add_argument("--kind", type=BackupKind, choices=list(BackupKind), default=BackupKind.DAILY)
    create.add_argument("--at", type=datetime.fromisoformat, default=None, help="Дата точки с UTC-смещением; для учений")
    commands.add_parser("verify")
    restore = commands.add_parser("restore")
    restore.add_argument("--snapshot", required=True)
    restore.add_argument("--target", required=True, type=Path)
    args = parser.parse_args()
    database = args.database.resolve()
    action = BackupAction(args.command)
    from diary.bootstrap import backup_runner

    try:
        backup_runner(database).execute(BackupCommand(
            action=action,
            backup=BackupInput(kind=args.kind, at=args.at or datetime.now(timezone.utc)) if action == BackupAction.BACKUP else None,
            restore=RestoreInput(snapshot=args.snapshot, target=str(args.target.resolve())) if action == BackupAction.RESTORE else None,
        ))
    except (Exception, KeyboardInterrupt):
        parser.exit(1, "Ошибка резервирования/восстановления. Проверьте состояние в настройках; параллельный запуск запрещён.\n")
    print("Готово.")
