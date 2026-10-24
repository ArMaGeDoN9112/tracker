from fastapi import FastAPI

from diary.application.backup import BackupStatus, GetBackupStatus


def register_backup_status(app: FastAPI, case: GetBackupStatus) -> None:
    @app.get("/api/backup-status")
    def backup_status() -> BackupStatus:
        return case.execute()
