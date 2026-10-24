from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from diary.application.errors import ApplicationError
from diary.interfaces.http.dto import ErrorOutput


def failure(code: str, message: str, status: int, field: str | None = None) -> JSONResponse:
    return JSONResponse(ErrorOutput(code=code, message=message, field=field).model_dump(mode="json"), status_code=status)


def application_failure(error: ApplicationError) -> JSONResponse:
    status = {
        "not_found": 404, "unavailable": 503, "validation": 422, "nonexistent_time": 422,
        "unit_change": 422, "invalid_credentials": 401, "login_limited": 429, "csrf": 403,
    }.get(error.code, 409)
    response = failure(error.code, str(error), status, error.field)
    if error.code == "login_limited":
        response.headers["Retry-After"] = "900"
    return response


def register_application_errors(app: FastAPI) -> None:
    @app.exception_handler(ApplicationError)
    async def application_error(_: Request, error: ApplicationError) -> JSONResponse:
        return application_failure(error)
