"""Keep every product available in the catalog."""
from alembic import op
import sqlalchemy as sa

revision = "010_remove_product_archive"
down_revision = "009_product_photos"


def upgrade():
    connection = op.get_bind()
    product = sa.Table("product", sa.MetaData(), autoload_with=connection)
    for constraint in list(product.constraints):
        if isinstance(constraint, sa.CheckConstraint) and str(constraint.sqltext) == "archived IN (0, 1)":
            product.constraints.remove(constraint)
    portions = sa.Table("product_portion", sa.MetaData(), autoload_with=connection)
    saved_portions = connection.execute(sa.select(portions)).mappings().all()
    # Keep FK checks enabled; deleting children also starts SQLite's DDL transaction.
    connection.execute(sa.delete(portions))
    with op.batch_alter_table("product", copy_from=product, recreate="always") as batch:
        batch.drop_column("archived")
    if saved_portions:
        connection.execute(sa.insert(portions), [dict(row) for row in saved_portions])


def downgrade():
    raise RuntimeError("Restore a verified backup instead of deleting diary data.")
