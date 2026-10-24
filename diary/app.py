import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError

from diary.bootstrap import (
    database_engine, check_access_database, register_access_http,
    register_diary_http, register_water_http, register_nutrition_http,
    register_reads_http, register_export_http, register_backup_status_http,
)
from diary.interfaces.http.errors import failure, register_application_errors
from diary.interfaces.http.access import validate_origin
from diary.body_limit import BodyLimit


def create_app(database: Path, origin: str) -> FastAPI:
    validate_origin(origin)
    engine = database_engine(database)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncGenerator[None]:
        try:
            check_access_database(engine)
            yield
        finally:
            engine.dispose()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    register_application_errors(app)
    app.add_middleware(BodyLimit)
    register_access_http(app, engine, origin)

    @app.exception_handler(RequestValidationError)
    async def invalid_input(request: Request, error: RequestValidationError) -> Response:
        # Pydantic's default errors include the submitted password.
        location = error.errors()[0]["loc"]
        field = str(location[-1]) if location and location[-1] != "body" else None
        message = "Проверьте введённые данные."
        if request.url.path.startswith("/api/water"):
            field = ".".join(str(part) for part in location[1:]) or None
            name = str(location[1]) if len(location) > 1 else ""
            message = {
                "volume_ml": "Объём воды: целые мл от 1 до 2147483647.",
                "volumes_ml": "Кнопки: уникальные целые объёмы от 1 до 2147483647 мл; пустой набор допустим.",
                "occurred_at": "Укажите дату RFC 3339 с явным смещением и точностью до миллисекунд.",
            }.get(name, message)
        if request.url.path.startswith(("/api/products", "/api/meals")):
            field = ".".join(str(part) for part in location[1:]) or None
            leaf = str(location[-1]) if location else ""
            message = {
                "name": "Название: от 1 до 200 символов без крайних пробелов.",
                "photo": "Не удалось принять фото. Выберите изображение заново; миниатюра должна быть JPEG до 45 000 символов.",
                "unit": "Выберите основу 100 г или 100 мл.",
                "quantity": "Количество порции: положительное десятичное число до 21474836,47, точность до сотых.",
                "protein": "Белки: десятичная строка от 0 до 21474836,47, точность до сотых; пустое — неизвестно.",
                "fat": "Жиры: десятичная строка от 0 до 21474836,47, точность до сотых; пустое — неизвестно.",
                "carbohydrate": "Углеводы: десятичная строка от 0 до 21474836,47, точность до сотых; пустое — неизвестно.",
                "calories": "Калории: десятичная строка от 0 до 21474836,47, точность до сотых; пустое — неизвестно.",
                "id": "Укажите уникальный UUID порции.",
                "portions": "Проверьте список порций и уникальность их UUID.",
            }.get(leaf, message)
            if request.url.path.startswith("/api/meals"):
                message = {
                    "quantity": "Количество: положительное десятичное число до 21474836,47, точность до сотых.",
                    "basis_quantity": "Основа продукта — 100 г или 100 мл.",
                    "lines": "Добавьте хотя бы одну строку; UUID строк не должны повторяться.",
                    "occurred_at": "Укажите дату RFC 3339 с явным смещением и точностью до миллисекунд.",
                    "category": "Выберите завтрак, обед, ужин, перекус либо оставьте пустой.",
                    "id": "Укажите уникальный UUID строки или порции.",
                    "product_id": "Укажите UUID исходного продукта.",
                    "product_revision": "Укажите положительную редакцию исходного продукта.",
                }.get(leaf, message)
        if request.url.path == "/api/temporary-basals":
            message = {
                "starts_at": "Укажите существующую дату RFC 3339 с явным смещением, с точностью до миллисекунд.",
                "duration_minutes": "Длительность: целое число минут от 1 до 2147483647.",
                "percent": "Процент: целое число от 0 до 2147483647; 100% означает обычную скорость.",
                "operation_id": "UUID операции имеет неверный формат.",
                None: "Окончание временной базы за пределами календаря. Уменьшите начало или длительность.",
            }.get(field, message)
        if request.url.path == "/api/basal-schedules":
            message = {
                "starts_at": "Укажите существующую дату RFC 3339 с явным смещением, с точностью до миллисекунд.",
                "intervals": "Начните с 00:00; интервалы должны идти строго по возрастанию без повторов (до 23:59).",
                "minute": "Минута интервала должна быть целым числом от 0 до 1439.",
                "rate": "Скорость: число от 0 до 21474836,47 ед/ч; два знака после запятой, завершающие нули допустимы.",
                "operation_id": "UUID операции имеет неверный формат.",
                None: "Проверьте начало действия и полное расписание с 00:00.",
            }.get(field, message)
        if request.url.path == "/api/entries" or request.url.path.startswith("/api/entries/"):
            message = {
                "glucose": "Сахар: положительное число до 214748364,7; один знак после запятой, завершающие нули допустимы.",
                "bolus": "Подколка: число от 0 до 214748364,7; один знак после запятой, завершающие нули допустимы.",
                "comment": "Комментарий должен быть текстом до 10 000 символов.",
                "reason": "Выберите причину: еда, коррекция, еда и коррекция, либо оставьте пустой.",
                "occurred_at": "Укажите существующую дату RFC 3339 с явным смещением, с точностью до миллисекунд.",
                "operation_id": "UUID операции имеет неверный формат.",
                "expected_revision": "Укажите целую положительную ожидаемую редакцию записи.",
                None: "Укажите сахар, ненулевую подколку или комментарий.",
            }.get(field, message)
        return failure("validation", message, 422, field)

    register_diary_http(app, engine)
    register_nutrition_http(app, engine)
    register_reads_http(app, engine)
    register_water_http(app, engine)
    register_export_http(app, engine)
    register_backup_status_http(app, database)
    return app


def from_env() -> FastAPI:
    return create_app(Path(os.environ["DIARY_DATABASE"]), os.environ["DIARY_ORIGIN"])
