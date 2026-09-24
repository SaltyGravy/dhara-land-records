from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    filename: Mapped[str] = mapped_column(String(255))
    storage_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    mime_type: Mapped[str] = mapped_column(String(100), default="application/octet-stream")
    file_size: Mapped[int] = mapped_column(Integer, default=0)
    state: Mapped[str] = mapped_column(String(100), default="Uttar Pradesh")
    district: Mapped[str] = mapped_column(String(100), default="Unassigned")
    doc_type: Mapped[str] = mapped_column(String(100), default="Land record")
    language: Mapped[str] = mapped_column(String(60), default="Auto-detect")
    status: Mapped[str] = mapped_column(String(30), default="Processing")
    confidence: Mapped[float] = mapped_column(Float, default=0)
    ocr_text: Mapped[str] = mapped_column(Text, default="")
    ocr_engine: Mapped[str] = mapped_column(String(100), default="Pending")
    checksum_sha256: Mapped[str] = mapped_column(String(64), default="")
    validation_issues: Mapped[str] = mapped_column(Text, default="[]")
    version: Mapped[int] = mapped_column(Integer, default=1)
    # Set when a single uploaded register lists multiple plots (Khata/Khasra rows) - each
    # plot becomes its own Document, and siblings share this value (the group's first/
    # primary document id) so they can be found together (e.g. "7 other plots from this
    # register"). Null for an ordinary single-plot upload.
    batch_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    fields: Mapped[list["ExtractedField"]] = relationship(back_populates="document", cascade="all, delete-orphan", order_by="ExtractedField.id")
    plot_rows: Mapped[list["PlotRow"]] = relationship(back_populates="document", cascade="all, delete-orphan", order_by="PlotRow.row_index")


class ExtractedField(Base):
    __tablename__ = "extracted_fields"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    label: Mapped[str] = mapped_column(String(100))
    value: Mapped[str] = mapped_column(Text, default="")
    original: Mapped[str] = mapped_column(Text, default="")
    confidence: Mapped[float] = mapped_column(Float, default=0)
    valid: Mapped[bool] = mapped_column(Boolean, default=False)
    verified: Mapped[bool] = mapped_column(Boolean, default=False)

    document: Mapped[Document] = relationship(back_populates="fields")


class PlotRow(Base):
    """One row of a tabular land register (e.g. a Bihar Jamabandi's Khata/Khasra/area table).

    A single document can list several plots; ExtractedField has no room for that (one value
    per canonical label), so plot rows are stored separately and shown as their own table.
    """

    __tablename__ = "plot_rows"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    row_index: Mapped[int] = mapped_column(Integer, default=0)
    khata: Mapped[str] = mapped_column(String(80), default="")
    khasra: Mapped[str] = mapped_column(String(80), default="")
    area: Mapped[str] = mapped_column(String(160), default="")
    rent: Mapped[str] = mapped_column(String(40), default="")
    cess: Mapped[str] = mapped_column(String(40), default="")

    document: Mapped[Document] = relationship(back_populates="plot_rows")


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_type: Mapped[str] = mapped_column(String(40), index=True)
    actor: Mapped[str] = mapped_column(String(100))
    action: Mapped[str] = mapped_column(Text)
    document_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    details: Mapped[str] = mapped_column(Text, default="")
    previous_hash: Mapped[str] = mapped_column(String(64), default="")
    event_hash: Mapped[str] = mapped_column(String(64), default="", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(50), index=True)
    # Null = national access (sees and manages every state). Set = confined to that one
    # state's records and staff - see app.scope_documents/scope_parcels/require_state_access.
    state: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ProcessingJob(Base):
    __tablename__ = "processing_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), unique=True, index=True)
    status: Mapped[str] = mapped_column(String(30), default="Queued", index=True)
    stage: Mapped[str] = mapped_column(String(80), default="Queued")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Parcel(Base):
    __tablename__ = "parcels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    khasra_number: Mapped[str] = mapped_column(String(80), index=True)
    owner: Mapped[str] = mapped_column(String(200))
    area_hectares: Mapped[float] = mapped_column(Float)
    classification: Mapped[str] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(30), default="Verified")
    state: Mapped[str] = mapped_column(String(100), default="Uttar Pradesh", index=True)
    village: Mapped[str] = mapped_column(String(100), index=True)
    tehsil: Mapped[str] = mapped_column(String(100), index=True)
    district: Mapped[str] = mapped_column(String(100), index=True)
    record_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    geometry_geojson: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class RegistryFlag(Base):
    """A locally maintained stand-in for the government registration/LRMS records this app
    doesn't yet have live credentials for (see canonical_record_payload / scripts/mock_lrms.py)
    - an active dispute or bank mortgage recorded against a khasra number, checked by
    validation._registry_flag_check before a record with a matching flag can be approved."""

    __tablename__ = "registry_flags"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    state: Mapped[str] = mapped_column(String(100), index=True)
    district: Mapped[str] = mapped_column(String(100), index=True)
    khasra_number: Mapped[str] = mapped_column(String(80), index=True)
    flag_type: Mapped[str] = mapped_column(String(30), default="Dispute")
    status: Mapped[str] = mapped_column(String(20), default="Active", index=True)
    reference: Mapped[str] = mapped_column(String(160), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(160))
    message: Mapped[str] = mapped_column(Text)
    level: Mapped[str] = mapped_column(String(30), default="info")
    read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class NotificationReceipt(Base):
    __tablename__ = "notification_receipts"
    __table_args__ = (UniqueConstraint("notification_id", "user_id", name="uq_notification_receipt"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    notification_id: Mapped[int] = mapped_column(ForeignKey("notifications.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    read_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class RecordRevision(Base):
    __tablename__ = "record_revisions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    actor: Mapped[str] = mapped_column(String(120))
    action: Mapped[str] = mapped_column(String(80))
    snapshot_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class FieldCorrection(Base):
    __tablename__ = "field_corrections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    field_label: Mapped[str] = mapped_column(String(100), index=True)
    predicted_value: Mapped[str] = mapped_column(Text, default="")
    corrected_value: Mapped[str] = mapped_column(Text, default="")
    source_excerpt: Mapped[str] = mapped_column(Text, default="")
    language: Mapped[str] = mapped_column(String(60), default="Unknown", index=True)
    actor: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
