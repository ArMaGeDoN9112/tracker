from typing import Callable

from fastapi import FastAPI, Response

from diary.application.export import ExportDiary
from diary.interfaces.export import full_export


def register_export(app: FastAPI, case: ExportDiary, clock: Callable[[], int]) -> None:
    @app.get("/api/export", response_class=Response)
    def download() -> Response:
        result = full_export(case.execute())
        return Response(result.model_dump_json(indent=2), media_type="application/json", headers={
            "Content-Disposition": f'attachment; filename="diabetes-diary-{clock()}.json"',
        })
