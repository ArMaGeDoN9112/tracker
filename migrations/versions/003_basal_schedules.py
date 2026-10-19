"""Immutable daily basal schedule history."""
from alembic import op
import sqlalchemy as sa

revision = "003_basal_schedules"
down_revision = "002_entries"


def upgrade():
    op.create_table(
        "basal_schedule",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("starts_at", sa.BigInteger, nullable=False, unique=True),
        sa.Column("created_at", sa.BigInteger, nullable=False),
    )
    op.create_table(
        "basal_interval",
        sa.Column("schedule_id", sa.Text, sa.ForeignKey("basal_schedule.id"), primary_key=True),
        sa.Column("minute", sa.Integer, primary_key=True),
        sa.Column("rate", sa.Integer, nullable=False),
        sa.CheckConstraint("minute BETWEEN 0 AND 1439"),
        sa.CheckConstraint("rate BETWEEN 0 AND 2147483647"),
    )


def downgrade():
    raise RuntimeError("Restore a verified backup instead of deleting diary data.")
