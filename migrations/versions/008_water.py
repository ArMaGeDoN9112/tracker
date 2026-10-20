"""Explicit water events and shared quick buttons."""
from alembic import op
import sqlalchemy as sa

revision = "008_water"
down_revision = "007_one_off_meals"


def upgrade():
    op.create_table(
        "water",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("volume_ml", sa.Integer, nullable=False),
        sa.Column("occurred_at", sa.BigInteger, nullable=False),
        sa.Column("revision", sa.BigInteger, nullable=False),
        sa.Column("created_at", sa.BigInteger, nullable=False),
        sa.Column("updated_at", sa.BigInteger, nullable=False),
        sa.Column("deleted_at", sa.BigInteger),
        sa.CheckConstraint("volume_ml BETWEEN 1 AND 2147483647"),
        sa.CheckConstraint("revision >= 1"),
    )
    op.create_index("water_day", "water", ["occurred_at", "created_at", "id"])
    settings = op.create_table(
        "water_settings",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("volumes_ml", sa.Text, nullable=False),
        sa.Column("revision", sa.BigInteger, nullable=False),
        sa.CheckConstraint("id = '00000000-0000-0000-0000-000000000001'"),
        sa.CheckConstraint("revision >= 1"),
    )
    op.bulk_insert(settings, [{"id": "00000000-0000-0000-0000-000000000001", "volumes_ml": "[200,250,500]", "revision": 1}])


def downgrade():
    raise RuntimeError("Restore a verified backup instead of deleting diary data.")
