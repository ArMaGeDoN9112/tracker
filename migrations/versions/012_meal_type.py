"""Store the selected meal type without guessing types for existing records."""
from alembic import op
import sqlalchemy as sa

revision = "012_meal_type"
down_revision = "011_remove_meal_category"


def upgrade():
    op.add_column("meal", sa.Column("meal_type", sa.Text, sa.CheckConstraint(
        "meal_type IS NULL OR meal_type IN ('breakfast','lunch','dinner','snack')", name="ck_meal_type")))


def downgrade():
    raise RuntimeError("Restore a verified backup instead of deleting diary data.")
