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
}

AUDIT_COLUMNS = {
    "previous_hash": "VARCHAR(64) NOT NULL DEFAULT ''",
    "event_hash": "VARCHAR(64) NOT NULL DEFAULT ''",
}


def upgrade_schema(engine: Engine) -> None:
    inspector = inspect(engine)
    if "documents" not in inspector.get_table_names():
        return
    existing = {column["name"] for column in inspector.get_columns("documents")}
    with engine.begin() as connection:
        for name, definition in DOCUMENT_COLUMNS.items():
            if name not in existing:
                connection.execute(text(f"ALTER TABLE documents ADD COLUMN {name} {definition}"))
    inspector = inspect(engine)
    if "audit_events" in inspector.get_table_names():
        existing_audit = {column["name"] for column in inspector.get_columns("audit_events")}
        with engine.begin() as connection:
            for name, definition in AUDIT_COLUMNS.items():
                if name not in existing_audit:
                    connection.execute(text(f"ALTER TABLE audit_events ADD COLUMN {name} {definition}"))
