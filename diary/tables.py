from sqlalchemy import BigInteger, Boolean, Integer, Text, column, table


# Query definitions only; Alembic migrations own the database schema.
account = table(
    "account",
    column("id", Integer),
    column("login", Text),
    column("password_hash", Text),
    column("created_at", BigInteger),
)
session = table(
    "session",
    column("token_hash", Text),
    column("account_id", Integer),
    column("created_at", BigInteger),
    column("expires_at", BigInteger),
)
pre_session = table(
    "pre_session",
    column("token_hash", Text),
    column("expires_at", BigInteger),
)
login_failure = table(
    "login_failure",
    column("id", Integer),
    column("source_hash", Text),
    column("login_hash", Text),
    column("created_at", BigInteger),
)
entry = table(
    "entry",
    column("id", Text),
    column("occurred_at", BigInteger),
    column("glucose", Integer),
    column("bolus", Integer),
    column("reason", Text),
    column("comment", Text),
    column("created_at", BigInteger),
    column("updated_at", BigInteger),
    column("revision", Integer),
    column("deleted_at", BigInteger),
)
operation_receipt = table(
    "operation_receipt",
    column("operation_id", Text),
    column("action", Text),
    column("request_hash", Text),
    column("result_id", Text),
    column("revision", Integer),
    column("completed_at", BigInteger),
)
basal_schedule = table(
    "basal_schedule",
    column("id", Text),
    column("starts_at", BigInteger),
    column("created_at", BigInteger),
)
basal_interval = table(
    "basal_interval",
    column("schedule_id", Text),
    column("minute", Integer),
    column("rate", Integer),
)
temporary_basal = table(
    "temporary_basal",
    column("id", Text),
    column("starts_at", BigInteger),
    column("ends_at", BigInteger),
    column("duration_minutes", Integer),
    column("percent", Integer),
    column("created_at", BigInteger),
    column("updated_at", BigInteger),
    column("revision", BigInteger),
    column("deleted_at", BigInteger),
)

product = table(
    "product", column("id", Text), column("name", Text), column("unit", Text),
    column("photo", Text),
    column("protein", Integer), column("fat", Integer), column("carbohydrate", Integer),
    column("calories", Integer), column("archived", Boolean), column("revision", BigInteger),
    column("created_at", BigInteger), column("updated_at", BigInteger),
)
product_portion = table(
    "product_portion", column("product_id", Text), column("id", Text), column("position", Integer),
    column("name", Text), column("quantity", Integer),
)

meal = table(
    "meal", column("id", Text), column("occurred_at", BigInteger), column("category", Text),
    column("revision", BigInteger), column("created_at", BigInteger),
    column("updated_at", BigInteger), column("deleted_at", BigInteger),
)
meal_line = table(
    "meal_line", column("meal_id", Text), column("id", Text), column("position", Integer),
    column("kind", Text), column("name", Text), column("unit", Text),
    column("quantity", Integer), column("basis_quantity", Integer),
    column("protein", Integer), column("fat", Integer), column("carbohydrate", Integer),
    column("calories", Integer), column("product_id", Text), column("product_revision", BigInteger),
    column("portion_id", Text), column("portion_name", Text), column("portion_quantity", Integer),
)

water = table(
    "water", column("id", Text), column("volume_ml", Integer), column("occurred_at", BigInteger),
    column("revision", BigInteger), column("created_at", BigInteger),
    column("updated_at", BigInteger), column("deleted_at", BigInteger),
)
water_settings = table(
    "water_settings", column("id", Text), column("volumes_ml", Text), column("revision", BigInteger),
)
