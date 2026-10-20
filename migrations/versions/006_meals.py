"""Meals with self-contained ordered catalog snapshots."""
from alembic import op
import sqlalchemy as sa

revision = "006_meals"
down_revision = "005_products"


def upgrade():
    op.create_table(
        "meal",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("occurred_at", sa.BigInteger, nullable=False),
        sa.Column("category", sa.Text),
        sa.Column("revision", sa.BigInteger, nullable=False),
        sa.Column("created_at", sa.BigInteger, nullable=False),
        sa.Column("updated_at", sa.BigInteger, nullable=False),
        sa.Column("deleted_at", sa.BigInteger),
        sa.CheckConstraint("revision >= 1"),
        sa.CheckConstraint("category IS NULL OR category IN ('breakfast','lunch','dinner','snack')"),
    )
    op.create_index("meal_day", "meal", ["occurred_at", "created_at", "id"])
    op.create_table(
        "meal_line",
        sa.Column("meal_id", sa.Text, sa.ForeignKey("meal.id"), primary_key=True),
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("unit", sa.Text, nullable=False),
        sa.Column("quantity", sa.Integer, nullable=False),
        sa.Column("basis_quantity", sa.Integer, nullable=False),
        *(sa.Column(name, sa.Integer) for name in ("protein", "fat", "carbohydrate", "calories")),
        # Provenance deliberately has no catalog FK: a snapshot owns its facts.
        sa.Column("product_id", sa.Text, nullable=False),
        sa.Column("product_revision", sa.BigInteger, nullable=False),
        sa.Column("portion_id", sa.Text),
        sa.Column("portion_name", sa.Text),
        sa.Column("portion_quantity", sa.Integer),
        sa.UniqueConstraint("meal_id", "position"),
        sa.CheckConstraint("position >= 0"),
        sa.CheckConstraint("kind = 'product'"),
        sa.CheckConstraint("length(trim(name)) BETWEEN 1 AND 200"),
        sa.CheckConstraint("unit IN ('g','ml')"),
        sa.CheckConstraint("quantity BETWEEN 1 AND 2147483647"),
        sa.CheckConstraint("basis_quantity = 10000"),
        sa.CheckConstraint("product_revision >= 1"),
        sa.CheckConstraint("(portion_id IS NULL AND portion_name IS NULL AND portion_quantity IS NULL) OR "
                           "(portion_id IS NOT NULL AND portion_name IS NOT NULL AND portion_quantity IS NOT NULL "
                           "AND length(trim(portion_name)) BETWEEN 1 AND 200 AND portion_quantity BETWEEN 1 AND 2147483647)"),
        *(sa.CheckConstraint(f"{name} IS NULL OR {name} BETWEEN 0 AND 2147483647")
          for name in ("protein", "fat", "carbohydrate", "calories")),
    )


def downgrade():
    raise RuntimeError("Restore a verified backup instead of deleting diary data.")
