"""Optional product photo thumbnails, included in SQLite backups."""
from alembic import op
import sqlalchemy as sa

revision = "009_product_photos"
down_revision = "008_water"


def upgrade():
    op.add_column("product", sa.Column("photo", sa.Text, nullable=True))


def downgrade():
    raise RuntimeError("Restore a verified backup instead of deleting diary data.")
