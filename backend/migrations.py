"""Small idempotent schema upgrades for the MVP.

Production deployments can replace this module with Alembic while retaining the
same SQLAlchemy metadata. Keeping upgrades here makes existing local databases
forward-compatible without deleting user records.
"""

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine


DOCUMENT_COLUMNS = {
    "checksum_sha256": "VARCHAR(64) NOT NULL DEFAULT ''",
    "validation_issues": "TEXT NOT NULL DEFAULT '[]'",
    "version": "INTEGER NOT NULL DEFAULT 1",
    "batch_id": "VARCHAR(32) NULL",
    "category": "VARCHAR(20) NOT NULL DEFAULT 'Rural'",
}

AUDIT_COLUMNS = {
    "previous_hash": "VARCHAR(64) NOT NULL DEFAULT ''",
    "event_hash": "VARCHAR(64) NOT NULL DEFAULT ''",
}

USER_COLUMNS = {
    # Nullable, no default: an existing user must stay national (state IS NULL) rather than
    # silently being fenced into whatever default we might pick for them.
    "state": "VARCHAR(100) NULL",
}

PARCEL_COLUMNS = {
    # Every parcel seeded before this column existed is Varanasi/Uttar Pradesh - see
    # seed_system_data - so that's the correct backfill, not an arbitrary placeholder.
    "state": "VARCHAR(100) NOT NULL DEFAULT 'Uttar Pradesh'",
    "category": "VARCHAR(20) NOT NULL DEFAULT 'Rural'",
}


def _add_missing_columns(engine: Engine, table: str, columns: dict[str, str]) -> None:
    inspector = inspect(engine)
    if table not in inspector.get_table_names():
        return
    existing = {column["name"] for column in inspector.get_columns(table)}
    with engine.begin() as connection:
        for name, definition in columns.items():
            if name not in existing:
                connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {definition}"))


def upgrade_schema(engine: Engine) -> None:
    _add_missing_columns(engine, "documents", DOCUMENT_COLUMNS)
    _add_missing_columns(engine, "audit_events", AUDIT_COLUMNS)
    _add_missing_columns(engine, "users", USER_COLUMNS)
    _add_missing_columns(engine, "parcels", PARCEL_COLUMNS)
