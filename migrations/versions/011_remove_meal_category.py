"""Remove meal categories while preserving compositions and history."""
from alembic import op
import sqlalchemy as sa

revision = "011_remove_meal_category"
down_revision = "010_remove_product_archive"


def upgrade():
    connection = op.get_bind()
    meal = sa.Table("meal", sa.MetaData(), autoload_with=connection)
    for constraint in list(meal.constraints):
        if isinstance(constraint, sa.CheckConstraint) and "category" in str(constraint.sqltext):
            meal.constraints.remove(constraint)
    lines = sa.Table("meal_line", sa.MetaData(), autoload_with=connection)
    saved_lines = connection.execute(sa.select(lines)).mappings().all()
    # Keep FK checks enabled; deleting children also starts SQLite's DDL transaction.
    connection.execute(sa.delete(lines))
    with op.batch_alter_table("meal", copy_from=meal, recreate="always") as batch:
        batch.drop_column("category")
    if saved_lines:
        connection.execute(sa.insert(lines), [dict(row) for row in saved_lines])


def downgrade():
    raise RuntimeError("Restore a verified backup instead of deleting diary data.")
