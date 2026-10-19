"""Diary entries and durable operation receipts."""
from alembic import op
import sqlalchemy as sa

revision = "002_entries"
down_revision = "001_access"


def upgrade():
    op.create_table(
        "entry",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("occurred_at", sa.BigInteger, nullable=False),
        sa.Column("glucose", sa.Integer),
        sa.Column("bolus", sa.Integer, nullable=False),
        sa.Column("reason", sa.Text),
        sa.Column("comment", sa.Text, nullable=False),
        sa.Column("created_at", sa.BigInteger, nullable=False),
        sa.Column("updated_at", sa.BigInteger, nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("deleted_at", sa.BigInteger),
        sa.CheckConstraint("glucose IS NULL OR glucose BETWEEN 1 AND 2147483647"),
        sa.CheckConstraint("bolus BETWEEN 0 AND 2147483647"),
        sa.CheckConstraint("reason IS NULL OR (bolus > 0 AND reason IN ('food', 'correction', 'food_and_correction'))"),
        sa.CheckConstraint("length(comment) <= 10000"),
        sa.CheckConstraint("glucose IS NOT NULL OR bolus > 0 OR length(trim(comment)) > 0"),
    )
    op.create_index("entry_chronology", "entry", ["occurred_at", "created_at", "id"])
    op.create_table(
        "operation_receipt",
        sa.Column("operation_id", sa.Text, primary_key=True),
        sa.Column("action", sa.Text, nullable=False),
        sa.Column("request_hash", sa.Text, nullable=False),
        sa.Column("result_id", sa.Text, nullable=False),
        sa.Column("revision", sa.Integer, nullable=False),
        sa.Column("completed_at", sa.BigInteger, nullable=False),
    )


def downgrade():
    raise RuntimeError("Restore a verified backup instead of deleting diary data.")
