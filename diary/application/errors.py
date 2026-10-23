class ApplicationError(Exception):
    code: str
    field: str | None = None


class OperationConflict(ApplicationError):
    code = "operation_conflict"
    field = "operation_id"

    def __init__(self) -> None:
        super().__init__("UUID уже использован с другими данными.")


class NotFound(ApplicationError):
    code = "not_found"


class RevisionConflict(ApplicationError):
    code = "revision_conflict"
    field = "expected_revision"


class UndoExpired(ApplicationError):
    code = "undo_expired"

    def __init__(self) -> None:
        super().__init__("30 секунд истекли. Отменить удаление уже нельзя.")


class Unavailable(ApplicationError):
    code = "unavailable"

    def __init__(self) -> None:
        super().__init__("Операция не сохранена. Повторите позже.")
