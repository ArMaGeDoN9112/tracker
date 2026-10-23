from dataclasses import dataclass
from typing import Callable, Literal
from uuid import UUID

from fastapi import FastAPI
from pydantic import BaseModel

from diary.application.products import (
    CreateProduct, EditProduct, EditProductCommand, EditProductInput,
    GetProduct, GetProducts, PortionInput, ProductInput, ProductQuery, ProductResult,
)
from diary.domain.precision import rate_string
from diary.interfaces.http.outputs import ReceiptOutput, receipt_output, timestamp


class ProductOutput(BaseModel):
    id: str
    name: str
    unit: Literal["g", "ml"]
    photo: str | None = None
    protein: str | None
    fat: str | None
    carbohydrate: str | None
    calories: str | None
    portions: list[PortionInput]
    revision: int
    created_at: str
    updated_at: str


def product_output(result: ProductResult) -> ProductOutput:
    record, portions = result.record, result.portions
    return ProductOutput(
        **record.model_dump(exclude={"protein", "fat", "carbohydrate", "calories", "created_at", "updated_at"}),
        protein=rate_string(record.protein) if record.protein is not None else None,
        fat=rate_string(record.fat) if record.fat is not None else None,
        carbohydrate=rate_string(record.carbohydrate) if record.carbohydrate is not None else None,
        calories=rate_string(record.calories) if record.calories is not None else None,
        portions=portions, created_at=timestamp(record.created_at), updated_at=timestamp(record.updated_at),
    )


@dataclass
class ProductUseCases:
    get: GetProduct
    list: GetProducts
    create: CreateProduct
    edit: EditProduct


def register_products(app: FastAPI, cases: ProductUseCases, clock: Callable[[], int]) -> None:
    @app.get("/api/products")
    def products() -> list[ProductOutput]:
        return [product_output(result) for result in cases.list.execute()]

    @app.get("/api/products/{product_id}", response_model=ProductOutput)
    def read_product(product_id: UUID) -> ProductOutput:
        return product_output(cases.get.execute(ProductQuery(product_id=str(product_id))))

    @app.post("/api/products", response_model=ReceiptOutput)
    def create_product(payload: ProductInput) -> ReceiptOutput:
        result = cases.create.execute(payload)
        return receipt_output(result.receipt, result.replayed, clock())

    @app.put("/api/products/{product_id}", response_model=ReceiptOutput)
    def edit_product(product_id: UUID, payload: EditProductInput) -> ReceiptOutput:
        command = EditProductCommand(**payload.model_dump(exclude_unset=True), product_id=str(product_id))
        result = cases.edit.execute(command)
        return receipt_output(result.receipt, result.replayed, clock())
