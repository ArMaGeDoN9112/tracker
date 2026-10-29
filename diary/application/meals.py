from dataclasses import dataclass
from datetime import datetime
from fractions import Fraction
from typing import Callable, ContextManager, Literal, Protocol, Self
from uuid import UUID

from pydantic import BaseModel, Field, ValidationInfo, field_validator, model_validator

from diary.application.entries import EntryInput
from diary.application.operations import OperationInput, RevisionInput
from diary.application.products import NamedInput, PortionInput, ProductInput
from diary.domain.nutrition import MealRecord, MealLineRecord, NUTRIENTS, NutrientValues, rounded
from diary.domain.precision import hundredths, rate_string
from diary.domain.time import milliseconds
from diary.application.errors import ApplicationError, NotFound, RevisionConflict, UndoExpired
from diary.application.operations import OperationAction, ReceiptResult, ReceiptStore, replay_receipt, save_receipt


class MealLineInput(NamedInput):
    id: str
    kind: Literal["product", "one_off"]
    basis_quantity: str | None = Field(default=None, max_length=10000, validate_default=True)
    quantity: str | None = Field(default=None, max_length=10000, validate_default=True)
    unit: Literal["g", "ml"] | None = Field(default=None, validate_default=True)
    protein: str | None = Field(default=None, max_length=10000)
    fat: str | None = Field(default=None, max_length=10000)
    carbohydrate: str | None = Field(default=None, max_length=10000)
    calories: str | None = Field(default=None, max_length=10000)
    product_id: str | None = Field(default=None, validate_default=True)
    product_revision: int | None = Field(default=None, ge=1, le=9223372036854775806, validate_default=True)
    portion: PortionInput | None = None

    @field_validator("id", "product_id")
    @classmethod
    def valid_uuid(cls, value: str | None) -> str | None:
        return str(UUID(value)) if value is not None else None

    @field_validator("quantity", "basis_quantity")
    @classmethod
    def amount(cls, value: str | None) -> str | None:
        return PortionInput.positive_quantity(value) if value is not None else None

    @field_validator("basis_quantity")
    @classmethod
    def product_basis(cls, value: str | None, info: ValidationInfo) -> str | None:
        if info.data.get("kind") == "product" and value != "100.00":
            raise ValueError("Основа продукта — 100 г или мл.")
        return value

    @field_validator("quantity")
    @classmethod
    def required_quantity(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is None and (info.data.get("kind") == "product" or info.data.get("basis_quantity") is not None):
            raise ValueError("При известной основе нужно съеденное количество.")
        return value

    @field_validator("unit")
    @classmethod
    def required_unit(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is None and (info.data.get("kind") == "product" or info.data.get("quantity") is not None or info.data.get("basis_quantity") is not None):
            raise ValueError("Для количества и основы выберите г или мл.")
        return value

    @field_validator("product_id", "product_revision", "portion")
    @classmethod
    def provenance(cls, value: str | int | PortionInput | None, info: ValidationInfo) -> str | int | PortionInput | None:
        if info.data.get("kind") == "one_off" and value is not None:
            raise ValueError("Разовая еда не имеет происхождения из каталога.")
        if info.data.get("kind") == "product" and info.field_name != "portion" and value is None:
            raise ValueError("Укажите происхождение продукта.")
        return value

    @model_validator(mode="after")
    def coherent_basis(self) -> Self:
        if self.kind == "one_off" and "basis_quantity" not in self.model_fields_set:
            self.basis_quantity = self.quantity
        return self

    @field_validator("protein", "fat", "carbohydrate", "calories")
    @classmethod
    def nutrient(cls, value: str | None) -> str | None:
        return ProductInput.nutrient(value)


class MealInput(OperationInput):
    occurred_at: str
    lines: list[MealLineInput] = Field(min_length=1)

    @model_validator(mode="before")
    @classmethod
    def legacy_header(cls, value: object) -> object:
        # Accept retries from clients opened before meal categories were removed.
        return {key: item for key, item in value.items() if key != "category"} if isinstance(value, dict) else value

    @field_validator("occurred_at")
    @classmethod
    def event_time(cls, value: str) -> str:
        return EntryInput.event_time(value)

    @field_validator("lines")
    @classmethod
    def unique_lines(cls, value: list[MealLineInput]) -> list[MealLineInput]:
        if len({line.id for line in value}) != len(value):
            raise ValueError("UUID строк не должны повторяться.")
        return value


class EditMealInput(MealInput, RevisionInput):
    pass


class MealProductPreviewInput(BaseModel):
    line: MealLineInput
    basis_quantity: str | None = Field(default=None, max_length=10000)
    unit: Literal["g", "ml"]

    @field_validator("basis_quantity")
    @classmethod
    def amount(cls, value: str | None) -> str | None:
        return MealLineInput.amount(value)


class MealResult(BaseModel):
    record: MealRecord
    lines: list[MealLineRecord]


class MealQuery(BaseModel):
    meal_id: str


class EditMealCommand(EditMealInput):
    meal_id: str


class MealRevisionCommand(RevisionInput):
    meal_id: str


class RepeatMealResult(BaseModel):
    occurred_at: int
    lines: list[MealLineInput]


class MealProductPreview(NutrientValues):
    name: str
    unit: Literal["g", "ml"]


class MealStore(Protocol):
    def get(self, meal_id: str) -> MealResult | None: ...
    def save(self, result: MealResult, *, create: bool, replace_lines: bool) -> None: ...


class MealUow(Protocol):
    meals: MealStore
    receipts: ReceiptStore

    def commit(self) -> None: ...


MealUowFactory = Callable[[], ContextManager[MealUow]]


def line_input(line: MealLineRecord) -> MealLineInput:
    portion = PortionInput(id=line.portion_id, name=line.portion_name, quantity=rate_string(line.portion_quantity)) \
        if line.portion_id is not None and line.portion_name is not None and line.portion_quantity is not None else None
    return MealLineInput(
        id=line.id, kind=line.kind, name=line.name, unit=line.unit,
        quantity=rate_string(line.quantity) if line.quantity is not None else None,
        basis_quantity=rate_string(line.basis_quantity) if line.basis_quantity is not None else None,
        product_id=line.product_id, product_revision=line.product_revision, portion=portion,
        **{name: rate_string(getattr(line, name)) if getattr(line, name) is not None else None for name in NUTRIENTS},
    )


def line_record(line: MealLineInput, meal_id: str, position: int) -> MealLineRecord:
    return MealLineRecord(
        meal_id=meal_id, id=line.id, position=position, kind=line.kind, name=line.name, unit=line.unit,
        quantity=hundredths(line.quantity) if line.quantity is not None else None,
        basis_quantity=hundredths(line.basis_quantity) if line.basis_quantity is not None else None,
        **{name: hundredths(getattr(line, name)) if getattr(line, name) is not None else None for name in NUTRIENTS},
        product_id=line.product_id, product_revision=line.product_revision,
        portion_id=line.portion.id if line.portion else None, portion_name=line.portion.name if line.portion else None,
        portion_quantity=hundredths(line.portion.quantity) if line.portion else None,
    )


@dataclass
class GetMeal:
    uow: MealUowFactory

    def execute(self, query: MealQuery) -> MealResult:
        with self.uow() as uow:
            result = uow.meals.get(query.meal_id)
            if result is None:
                raise NotFound("Приём пищи не найден.")
            return result


@dataclass
class RepeatMeal:
    uow: MealUowFactory
    clock: Callable[[], int]
    new_id: Callable[[], str]

    def execute(self, query: MealQuery) -> RepeatMealResult:
        with self.uow() as uow:
            source = uow.meals.get(query.meal_id)
            if source is None or source.record.deleted_at is not None:
                raise NotFound("Неудалённый приём пищи не найден.")
            return RepeatMealResult(occurred_at=self.clock(),
                lines=[line_input(line).model_copy(update={"id": self.new_id()}) for line in source.lines])


class InvalidPreview(ApplicationError):
    code = "validation"

    def __init__(self, message: str, field: str) -> None:
        super().__init__(message)
        self.field = field


@dataclass
class PreviewMealProduct:
    def execute(self, payload: MealProductPreviewInput) -> MealProductPreview:
        line = payload.line
        basis = line.basis_quantity or payload.basis_quantity
        if line.kind != "one_off":
            raise InvalidPreview("Выберите разовую еду.", "line.kind")
        if basis is None:
            raise InvalidPreview("Введите фактическое количество исходной порции или заполните новую карточку независимо.", "basis_quantity")
        if line.basis_quantity is not None and payload.unit != line.unit:
            raise InvalidPreview("Единица должна совпадать с исходной основой.", "unit")
        values = {name: rounded(Fraction(hundredths(getattr(line, name)) * 10000, hundredths(basis)))
                  if getattr(line, name) is not None else None for name in NUTRIENTS}
        if any(Fraction(value) > Fraction(2147483647, 100) for value in values.values() if value is not None):
            raise InvalidPreview("Значение на 100 превышает предел карточки. Заполните её независимо.", "basis_quantity")
        return MealProductPreview(name=line.name, unit=payload.unit, **values)


@dataclass
class MealOperations:
    uow: MealUowFactory
    clock: Callable[[], int]
    new_id: Callable[[], str]

    def change(self, action: OperationAction, payload: MealInput | RevisionInput, meal_id: str | None = None) -> ReceiptResult:
        normalized = payload.model_dump(exclude={"operation_id", "meal_id"})
        normalized["meal_id"] = meal_id
        with self.uow() as uow:
            replay = replay_receipt(uow.receipts, action, payload.operation_id, normalized)
            if replay is not None:
                return ReceiptResult(receipt=replay, replayed=True)
            now = self.clock()
            result_id = meal_id or self.new_id()
            record = MealRecord(id=result_id, occurred_at=0, revision=1,
                                created_at=now, updated_at=now, deleted_at=None)
            lines: list[MealLineRecord] = []
            if isinstance(payload, RevisionInput):
                saved = uow.meals.get(result_id)
                if saved is None:
                    raise NotFound("Приём пищи не найден.")
                record, lines = saved.record, saved.lines
                if record.revision != payload.expected_revision or (record.deleted_at is not None) != (action == OperationAction.RESTORE_MEAL):
                    raise RevisionConflict("Приём пищи изменён на другом устройстве. Загрузите актуальный для сравнения.")
                if action == OperationAction.RESTORE_MEAL and record.deleted_at is not None and now >= record.deleted_at + 30000:
                    raise UndoExpired()
                record.revision += 1
                record.updated_at = now
            if isinstance(payload, MealInput):
                record.occurred_at = milliseconds(datetime.fromisoformat(payload.occurred_at))
                lines = [line_record(line, result_id, position) for position, line in enumerate(payload.lines)]
            else:
                record.deleted_at = now if action == OperationAction.DELETE_MEAL else None
            uow.meals.save(MealResult(record=record, lines=lines), create=meal_id is None, replace_lines=isinstance(payload, MealInput))
            receipt = save_receipt(uow.receipts, action, payload.operation_id, normalized, result_id, record.revision, now)
            uow.commit()
            return ReceiptResult(receipt=receipt, replayed=False)


@dataclass
class CreateMeal:
    operations: MealOperations

    def execute(self, payload: MealInput) -> ReceiptResult:
        return self.operations.change(OperationAction.CREATE_MEAL, payload)


@dataclass
class EditMeal:
    operations: MealOperations

    def execute(self, payload: EditMealCommand) -> ReceiptResult:
        return self.operations.change(OperationAction.EDIT_MEAL, payload, payload.meal_id)


@dataclass
class DeleteMeal:
    operations: MealOperations

    def execute(self, payload: MealRevisionCommand) -> ReceiptResult:
        return self.operations.change(OperationAction.DELETE_MEAL, payload, payload.meal_id)


@dataclass
class RestoreMeal:
    operations: MealOperations

    def execute(self, payload: MealRevisionCommand) -> ReceiptResult:
        return self.operations.change(OperationAction.RESTORE_MEAL, payload, payload.meal_id)
