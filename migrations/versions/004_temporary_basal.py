"""Temporary basal periods; effective ends are derived, never stored."""
from alembic import op
import sqlalchemy as sa

revision = "004_temporary_basal"
down_revision = "003_basal_schedules"


def upgrade():
    op.create_table(
        "temporary_basal",
        sa.Column("id", sa.Text, primary_key=True),
        sa.Column("starts_at", sa.BigInteger, nullable=False),
        sa.Column("ends_at", sa.BigInteger, nullable=False),
        sa.Column("duration_minutes", sa.Integer, nullable=False),
        sa.Column("percent", sa.Integer, nullable=False),
        sa.Column("created_at", sa.BigInteger, nullable=False),
        sa.Column("updated_at", sa.BigInteger, nullable=False),
        sa.Column("revision", sa.BigInteger, nullable=False),
        sa.Column("deleted_at", sa.BigInteger),
        sa.CheckConstraint("ends_at >= starts_at"),
        sa.CheckConstraint("duration_minutes BETWEEN 1 AND 2147483647"),
        sa.CheckConstraint("percent BETWEEN 0 AND 2147483647"),
        sa.CheckConstraint("revision >= 1"),
    )
    op.create_index("temporary_basal_start", "temporary_basal", ["starts_at"], unique=True,
                    sqlite_where=sa.text("deleted_at IS NULL"))


def downgrade():
    raise RuntimeError("Restore a verified backup instead of deleting diary data.")
