import hashlib
import hmac
import os
import threading
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import AuditEvent


AUDIT_KEY = os.getenv("AUDIT_SIGNING_KEY", os.getenv("TOKEN_SECRET", "development-only-change-this-secret")).encode()
AUDIT_WRITE_LOCK = threading.Lock()


def event_digest(previous_hash: str, event_type: str, actor: str, action: str, document_id: str | None, details: str, created_at: datetime) -> str:
    if created_at.tzinfo is not None:
        created_at = created_at.astimezone(timezone.utc).replace(tzinfo=None)
    canonical_time = created_at.isoformat(timespec="microseconds")
    payload = "|".join([previous_hash, event_type, actor, action, document_id or "", details, canonical_time]).encode()
    return hmac.new(AUDIT_KEY, payload, hashlib.sha256).hexdigest()


def append_event(db: Session, event_type: str, actor: str, action: str, document_id: str | None = None, details: str = "") -> AuditEvent:
    previous = db.scalar(select(AuditEvent.event_hash).order_by(AuditEvent.id.desc()).limit(1)) or ""
    created_at = datetime.now(timezone.utc)
    event = AuditEvent(
        event_type=event_type, actor=actor, action=action, document_id=document_id, details=details,
        previous_hash=previous, created_at=created_at,
    )
    event.event_hash = event_digest(previous, event_type, actor, action, document_id, details, created_at)
    db.add(event)
    db.flush()
    return event


def append_and_commit(db: Session, event_type: str, actor: str, action: str, document_id: str | None = None, details: str = "") -> AuditEvent:
    with AUDIT_WRITE_LOCK:
        event = append_event(db, event_type, actor, action, document_id, details)
        db.commit()
        return event


def rebuild_chain(db: Session) -> None:
    """Initialize hashes for legacy rows without rewriting signed history.

    Existing hashes are deliberately preserved so a modified event remains
    detectable after an application restart.
    """
    previous = ""
    for event in db.scalars(select(AuditEvent).order_by(AuditEvent.id)):
        if not event.event_hash:
            event.previous_hash = previous
            event.event_hash = event_digest(previous, event.event_type, event.actor, event.action, event.document_id, event.details, event.created_at)
        previous = event.event_hash
    db.flush()


def verify_chain(db: Session) -> tuple[bool, int]:
    previous = ""
    count = 0
    for event in db.scalars(select(AuditEvent).order_by(AuditEvent.id)):
        expected = event_digest(previous, event.event_type, event.actor, event.action, event.document_id, event.details, event.created_at)
        if event.previous_hash != previous or not hmac.compare_digest(event.event_hash, expected):
            return False, count
        previous = event.event_hash
        count += 1
    return True, count
