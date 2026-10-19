"""Single account, opaque sessions and persistent login limits."""
from alembic import op
import sqlalchemy as sa

revision = "001_access"
down_revision = None


def upgrade():
    op.create_table(
        "account",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("login", sa.Text, nullable=False, unique=True),
        sa.Column("password_hash", sa.Text, nullable=False),
        sa.Column("created_at", sa.BigInteger, nullable=False),
        sa.CheckConstraint("id = 1", name="single_account"),
    )
    op.create_table(
        "session",
        sa.Column("token_hash", sa.Text, primary_key=True),
        sa.Column("account_id", sa.Integer, sa.ForeignKey("account.id"), nullable=False),
        sa.Column("created_at", sa.BigInteger, nullable=False),
        sa.Column("expires_at", sa.BigInteger, nullable=False, index=True),
    )
    op.create_table(
        "pre_session",
        sa.Column("token_hash", sa.Text, primary_key=True),
        sa.Column("expires_at", sa.BigInteger, nullable=False, index=True),
    )
    op.create_table(
        "login_failure",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("source_hash", sa.Text, nullable=False, index=True),
        sa.Column("login_hash", sa.Text, nullable=False, index=True),
        sa.Column("created_at", sa.BigInteger, nullable=False, index=True),
    )


def downgrade():
    raise RuntimeError("Restore a verified backup instead of deleting access data.")
