from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from diary.application.errors import ApplicationError
from diary.dto import ErrorOutput


def register_application_errors(app: FastAPI) -> None:
    @app.exception_handler(ApplicationError)
    async def application_error(_: Request, error: ApplicationError) -> JSONResponse:
        status = {"not_found": 404, "unavailable": 503, "validation": 422, "nonexistent_time": 422, "unit_change": 422}.get(error.code, 409)
        return JSONResponse(ErrorOutput(code=error.code, message=str(error), field=error.field).model_dump(), status_code=status)
