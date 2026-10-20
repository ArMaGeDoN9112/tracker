"""Personal product catalog and ordered portions."""
from alembic import op
import sqlalchemy as sa

revision = "005_products"
down_revision = "004_temporary_basal"


def upgrade():
    op.create_table(
        "product",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("unit", sa.Text, nullable=False),
        *(sa.Column(name, sa.Integer) for name in ("protein", "fat", "carbohydrate", "calories")),
        sa.Column("archived", sa.Boolean, nullable=False),
        sa.Column("revision", sa.BigInteger, nullable=False),
        sa.Column("created_at", sa.BigInteger, nullable=False),
        sa.Column("updated_at", sa.BigInteger, nullable=False),
        sa.CheckConstraint("length(trim(name)) BETWEEN 1 AND 200"),
        sa.CheckConstraint("unit IN ('g', 'ml')"),
        sa.CheckConstraint("archived IN (0, 1)"),
        sa.CheckConstraint("revision >= 1"),
        *(sa.CheckConstraint(f"{name} IS NULL OR {name} BETWEEN 0 AND 2147483647")
          for name in ("protein", "fat", "carbohydrate", "calories")),
    )
    op.create_table(
        "product_portion",
        sa.Column("product_id", sa.Text, sa.ForeignKey("product.id"), primary_key=True),
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("quantity", sa.Integer, nullable=False),
        sa.UniqueConstraint("product_id", "position"),
        sa.CheckConstraint("position >= 0"),
        sa.CheckConstraint("length(trim(name)) BETWEEN 1 AND 200"),
        sa.CheckConstraint("quantity BETWEEN 1 AND 2147483647"),
    )


def downgrade():
    raise RuntimeError("Restore a verified backup instead of deleting diary data.")
