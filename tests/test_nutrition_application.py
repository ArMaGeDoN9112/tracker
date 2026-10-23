from collections.abc import Generator
from contextlib import contextmanager
from copy import deepcopy
from uuid import uuid4

import pytest

from diary.application.products import CreateProduct, GetProduct, ProductOperations, ProductQuery, ProductInput
from test_water_application import MemoryReceipts
from test_products import product
from diary.application.meals import CreateMeal, GetMeal, MealOperations, MealQuery, MealInput
from test_meals import meal


from diary.application.errors import NotFound, OperationConflict, RevisionConflict, Unavailable, UndoExpired
from diary.application.products import EditProduct, EditProductCommand, GetProducts, UnitChange
from diary.application.meals import (
    DeleteMeal, EditMeal, EditMealCommand, MealRevisionCommand, RepeatMeal, RestoreMeal,
    PreviewMealProduct, MealProductPreviewInput, InvalidPreview,
)


class MemoryProducts:
    def __init__(self):
        self.records = {}

    def get(self, product_id):
        return deepcopy(self.records.get(product_id))

    def all(self):
        return sorted(deepcopy(list(self.records.values())), key=lambda item: (item.record.created_at, item.record.id))

    def save(self, result, *, create):
        self.records[result.record.id] = deepcopy(result)


class MemoryNutritionUow:
    def __init__(self):
        self.products = MemoryProducts()
        self.meals = MemoryMeals()
        self.receipts = MemoryReceipts()

    @contextmanager
    def open(self) -> Generator["MemoryNutritionUow"]:
        before = deepcopy((self.products, self.meals, self.receipts))
        self.committed = False
        try:
            yield self
        finally:
            if not self.committed:
                self.products, self.meals, self.receipts = before

    def commit(self):
        self.committed = True


def test_catalog_creation_and_replay_without_http_or_database():
    store = MemoryNutritionUow()
    ids = iter([str(uuid4())])
    create = CreateProduct(ProductOperations(store.open, lambda: 1792400000000, lambda: next(ids)))
    payload = ProductInput(**product())
    first = create.execute(payload)
    replay = create.execute(payload)
    assert replay.replayed and replay.receipt == first.receipt
    saved = GetProduct(store.open).execute(ProductQuery(product_id=first.receipt.result_id))
    assert (saved.record.protein, saved.record.calories, saved.record.created_at) == (1000, None, 1792400000000)
    assert saved.portions == payload.portions


class MemoryMeals:
    def __init__(self):
        self.records = {}

    def get(self, meal_id):
        return deepcopy(self.records.get(meal_id))

    def save(self, result, *, create, replace_lines):
        self.records[result.record.id] = deepcopy(result)


def test_meal_creation_retains_unknown_nutrients_and_replays():
    store = MemoryNutritionUow()
    ids = iter([str(uuid4())])
    create = CreateMeal(MealOperations(store.open, lambda: 1792400000000, lambda: next(ids)))
    payload = MealInput(**meal([{'id': str(uuid4()), 'kind': 'one_off', 'name': 'Обед', 'protein': '1,50'}]))
    first = create.execute(payload)
    assert create.execute(payload).replayed
    saved = GetMeal(store.open).execute(MealQuery(meal_id=first.receipt.result_id))
    assert (saved.record.occurred_at, saved.record.created_at) == (1792357200123, 1792400000000)
    assert (saved.lines[0].protein, saved.lines[0].fat, saved.lines[0].basis_quantity) == (150, None, None)


@pytest.fixture
def nutrition_app():
    store = MemoryNutritionUow()
    clock = [1792400000000]
    args = (store.open, lambda: clock[0], lambda: str(uuid4()))
    return store, clock, ProductOperations(*args), MealOperations(*args)


def create_food(products, meals):
    card = ProductInput(**product())
    receipt = CreateProduct(products).execute(card).receipt
    payload = MealInput(**meal([{
        'id': str(uuid4()), 'kind': 'product', 'name': card.name, 'unit': card.unit,
        'quantity': '50', 'basis_quantity': '100', 'protein': card.protein,
        'product_id': receipt.result_id, 'product_revision': 1, 'portion': card.portions[0].model_dump(),
    }]))
    food = CreateMeal(meals).execute(payload).receipt
    return card, receipt, payload, food


def test_catalog_edit_keeps_history_and_repeat_has_new_line_ids(nutrition_app):
    store, clock, products, meals = nutrition_app
    card, receipt, payload, food = create_food(products, meals)
    before = GetMeal(store.open).execute(MealQuery(meal_id=food.result_id))
    clock[0] += 1000
    EditProduct(products).execute(EditProductCommand(**{
        **card.model_dump(), 'operation_id': str(uuid4()), 'protein': '20', 'portions': [],
        'expected_revision': 1, 'product_id': receipt.result_id,
    }))
    assert GetMeal(store.open).execute(MealQuery(meal_id=food.result_id)) == before
    repeated = RepeatMeal(store.open, lambda: clock[0], lambda: str(uuid4())).execute(MealQuery(meal_id=food.result_id))
    assert repeated.occurred_at == clock[0]
    assert repeated.lines[0].id != payload.lines[0].id
    assert (repeated.lines[0].protein, repeated.lines[0].portion, repeated.lines[0].product_revision) == ('10.00', card.portions[0], 1)
    assert GetProducts(store.open).execute()[0].record.protein == 2000


def test_unit_change_requires_confirmation_and_new_portions(nutrition_app):
    store, clock, products, meals = nutrition_app
    card = ProductInput(**product())
    receipt = CreateProduct(products).execute(card).receipt
    change = {**card.model_dump(), 'operation_id': str(uuid4()), 'product_id': receipt.result_id,
              'expected_revision': 1, 'unit': 'ml'}
    for extra in ({}, {'unit_change_confirmed': True}):
        with pytest.raises(UnitChange):
            EditProduct(products).execute(EditProductCommand(**{**change, **extra}))
    result = EditProduct(products).execute(EditProductCommand(**{**change, 'unit_change_confirmed': True, 'portions': []}))
    assert result.receipt.revision == 2
    with pytest.raises(RevisionConflict):
        EditProduct(products).execute(EditProductCommand(**{**change, 'operation_id': str(uuid4())}))


def test_product_photo_omission_preserves_photo_but_explicit_null_clears(nutrition_app):
    store, clock, products, meals = nutrition_app
    card = ProductInput(**product(photo='data:image/jpeg;base64,/9j//9k='))
    receipt = CreateProduct(products).execute(card).receipt
    data = card.model_dump(exclude={'photo'})
    data.update(operation_id=str(uuid4()), product_id=receipt.result_id, expected_revision=1)
    EditProduct(products).execute(EditProductCommand(**data))
    assert GetProduct(store.open).execute(ProductQuery(product_id=receipt.result_id)).record.photo == card.photo
    data.update(operation_id=str(uuid4()), expected_revision=2, photo=None)
    EditProduct(products).execute(EditProductCommand(**data))
    assert GetProduct(store.open).execute(ProductQuery(product_id=receipt.result_id)).record.photo is None


@pytest.mark.parametrize('elapsed,expired', [(29999, False), (30000, True)])
def test_meal_delete_replay_does_not_extend_undo(nutrition_app, elapsed, expired):
    store, clock, products, meals = nutrition_app
    _, _, payload, food = create_food(products, meals)
    query = MealQuery(meal_id=food.result_id)
    command = MealRevisionCommand(meal_id=food.result_id, expected_revision=1, operation_id=str(uuid4()))
    deleted = DeleteMeal(meals).execute(command)
    clock[0] += elapsed
    replay = DeleteMeal(meals).execute(command)
    assert replay.replayed and replay.receipt == deleted.receipt
    with pytest.raises(NotFound):
        RepeatMeal(store.open, lambda: clock[0], lambda: str(uuid4())).execute(query)
    restore = MealRevisionCommand(meal_id=food.result_id, expected_revision=2, operation_id=str(uuid4()))
    if expired:
        with pytest.raises(UndoExpired):
            RestoreMeal(meals).execute(restore)
    else:
        assert RestoreMeal(meals).execute(restore).receipt.revision == 3
        assert GetMeal(store.open).execute(query).record.deleted_at is None


def test_meal_edit_replaces_composition_and_checks_uuid_and_revision(nutrition_app):
    store, clock, products, meals = nutrition_app
    _, _, payload, food = create_food(products, meals)
    with pytest.raises(OperationConflict):
        CreateMeal(meals).execute(payload.model_copy(update={'category': 'lunch'}))
    command = EditMealCommand(**{**payload.model_dump(), 'operation_id': str(uuid4()), 'meal_id': food.result_id,
                                'expected_revision': 1, 'lines': [{'id': str(uuid4()), 'name': 'Суп', 'kind': 'one_off', 'calories': '15'}]})
    EditMeal(meals).execute(command)
    saved = GetMeal(store.open).execute(MealQuery(meal_id=food.result_id))
    assert len(saved.lines) == 1 and saved.lines[0].calories == 1500 and saved.lines[0].product_id is None
    with pytest.raises(RevisionConflict):
        EditMeal(meals).execute(command.model_copy(update={'operation_id': str(uuid4())}))


@pytest.mark.parametrize('kind', ['product', 'meal'])
def test_receipt_failure_rolls_back_nutrition_and_allows_retry(nutrition_app, monkeypatch, kind):
    store, clock, products, meals = nutrition_app
    card, receipt, payload, food = create_food(products, meals)
    before_products = GetProducts(store.open).execute()
    before_meal = GetMeal(store.open).execute(MealQuery(meal_id=food.result_id))
    if kind == 'product':
        case = EditProduct(products)
        command = EditProductCommand(**{**card.model_dump(), 'operation_id': str(uuid4()), 'product_id': receipt.result_id,
                                       'expected_revision': 1, 'portions': [], 'protein': '20'})
    else:
        case = EditMeal(meals)
        command = EditMealCommand(**{**payload.model_dump(), 'operation_id': str(uuid4()), 'meal_id': food.result_id,
                                    'expected_revision': 1, 'lines': [{'id': str(uuid4()), 'name': 'Суп', 'kind': 'one_off'}]})
    def fail(self, receipt):
        raise Unavailable()
    with monkeypatch.context() as patch:
        patch.setattr(MemoryReceipts, 'add', fail)
        with pytest.raises(Unavailable):
            case.execute(command)
    assert GetProducts(store.open).execute() == before_products
    assert GetMeal(store.open).execute(MealQuery(meal_id=food.result_id)) == before_meal
    assert case.execute(command).receipt.revision == 2


def test_preview_one_off_food_rounds_and_retains_unknowns():
    payload = MealProductPreviewInput(line={'id': str(uuid4()), 'name': 'Суп', 'kind': 'one_off',
        'quantity': '30', 'unit': 'g', 'protein': '1'}, unit='g')
    result = PreviewMealProduct().execute(payload)
    assert (result.protein, result.fat) == ('3.33', None)
    with pytest.raises(InvalidPreview) as error:
        PreviewMealProduct().execute(payload.model_copy(update={'unit': 'ml'}))
    assert error.value.field == 'unit'


@pytest.mark.parametrize('kind', ['product', 'meal'])
def test_missing_nutrition_record_is_typed_not_found(nutrition_app, kind):
    store, *_ = nutrition_app
    with pytest.raises(NotFound):
        if kind == 'product':
            GetProduct(store.open).execute(ProductQuery(product_id=str(uuid4())))
        else:
            GetMeal(store.open).execute(MealQuery(meal_id=str(uuid4())))
