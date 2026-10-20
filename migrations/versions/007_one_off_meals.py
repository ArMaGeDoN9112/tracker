"""One-off portions with an independent, nullable calculation basis."""
from alembic import op
import sqlalchemy as sa

revision = "007_one_off_meals"
down_revision = "006_meals"


def upgrade():
    previous = sa.Table("meal_line", sa.MetaData(), autoload_with=op.get_bind())
    op.create_table(
        "meal_line_new",
        sa.Column("meal_id", sa.Text, sa.ForeignKey("meal.id"), primary_key=True),
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("unit", sa.Text),
        sa.Column("quantity", sa.Integer),
        sa.Column("basis_quantity", sa.Integer),
        *(sa.Column(name, sa.Integer) for name in ("protein", "fat", "carbohydrate", "calories")),
        sa.Column("product_id", sa.Text),
        sa.Column("product_revision", sa.BigInteger),
        sa.Column("portion_id", sa.Text),
        sa.Column("portion_name", sa.Text),
        sa.Column("portion_quantity", sa.Integer),
        sa.UniqueConstraint("meal_id", "position"),
        sa.CheckConstraint("position >= 0"),
        sa.CheckConstraint("length(trim(name)) BETWEEN 1 AND 200"),
        sa.CheckConstraint("unit IS NULL OR unit IN ('g','ml')"),
        sa.CheckConstraint("quantity IS NULL OR quantity BETWEEN 1 AND 2147483647"),
        sa.CheckConstraint("basis_quantity IS NULL OR basis_quantity BETWEEN 1 AND 2147483647"),
        sa.CheckConstraint("(kind = 'product' AND unit IS NOT NULL AND quantity IS NOT NULL "
                           "AND basis_quantity IS NOT NULL AND basis_quantity = 10000 "
                           "AND product_id IS NOT NULL AND product_revision IS NOT NULL AND product_revision >= 1) OR "
                           "(kind = 'one_off' AND product_id IS NULL AND product_revision IS NULL AND portion_id IS NULL "
                           "AND (quantity IS NULL OR unit IS NOT NULL) "
                           "AND (basis_quantity IS NULL OR (quantity IS NOT NULL AND unit IS NOT NULL)))"),
        sa.CheckConstraint("(portion_id IS NULL AND portion_name IS NULL AND portion_quantity IS NULL) OR "
                           "(portion_id IS NOT NULL AND portion_name IS NOT NULL AND portion_quantity IS NOT NULL "
                           "AND length(trim(portion_name)) BETWEEN 1 AND 200 AND portion_quantity BETWEEN 1 AND 2147483647)"),
        *(sa.CheckConstraint(f"{name} IS NULL OR {name} BETWEEN 0 AND 2147483647")
          for name in ("protein", "fat", "carbohydrate", "calories")),
    )
    target = sa.table("meal_line_new", *(sa.column(column.name) for column in previous.columns))
    op.get_bind().execute(sa.insert(target).from_select(list(previous.columns.keys()), sa.select(previous)))
    op.drop_table("meal_line")
    op.rename_table("meal_line_new", "meal_line")


def downgrade():
    raise RuntimeError("Restore a verified backup instead of deleting diary data.")
