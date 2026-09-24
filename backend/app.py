import asyncio
import csv
import hashlib
import io
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session, selectinload

from .audit import append_and_commit, rebuild_chain, verify_chain
from .database import DATABASE_URL, Base, SessionLocal, engine, get_db
from .models import AuditEvent, Document, ExtractedField, FieldCorrection, Notification, NotificationReceipt, Parcel, PlotRow, ProcessingJob, RecordRevision, RegistryFlag, User
from .migrations import upgrade_schema
from .ocr import FIELD_RULES, detect_language, extract_fields, extract_text
from .schemas import (
    AdminUserOut, ApprovalRequest, AuditOut, DocumentOut, ExtractionFailure, ExtractionSubmission, FieldOut, FieldUpdate, LoginRequest,
    NotificationOut, ParcelUpdate, PlotRowIn, PlotRowOut, RegistryFlagIn, RegistryFlagOut, RegistryFlagUpdate, StatsOut, TokenOut, UserCreate, UserOut, UserUpdate,
)
from .security import create_access_token, effective_state, get_current_user, hash_password, require_roles, verify_password
from .storage import BLOB_ENABLED, encrypt_and_store, malware_scan, materialize_decrypted, read_and_decrypt, validate_document
from .validation import validate_record


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if os.getenv("VERCEL"):
    import shutil
    UPLOAD_DIR = Path("/tmp/dhara_uploads")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    src_uploads = PROJECT_ROOT / "data" / "uploads"
    if src_uploads.exists():
        for item in src_uploads.glob("*"):
            if item.is_file() and not (UPLOAD_DIR / item.name).exists():
                shutil.copy2(item, UPLOAD_DIR / item.name)
else:
    UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", PROJECT_ROOT / "data" / "uploads"))
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_BATCH_FILES = 20
ALLOWED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff"}
ALLOWED_MIME_TYPES = {"application/pdf", "image/png", "image/jpeg", "image/tiff", "application/octet-stream"}
READ_ROLES = ("Administrator", "Verification Officer", "Data Operator", "Auditor", "Viewer")
REVIEW_ROLES = ("Administrator", "Verification Officer")
UPLOAD_ROLES = ("Administrator", "Data Operator")
AUDIT_ROLES = ("Administrator", "Verification Officer", "Auditor")
STANDARD_FIELD_LABELS = [label for label, _ in FIELD_RULES]
# How many times a (field, language, corrected value) has to be confirmed by a reviewer
# before /api/model/metrics reports it as a "learned pattern" - also gates automatic reuse
# density reporting, not just the reuse itself (extract_fields reuses a correction after a
# single confirmation; this threshold is about what's worth surfacing as a trend).
ADAPTIVE_THRESHOLD = 2
INTEGRATION_URL_VARS = {
    "LRMS": "LRMS_BASE_URL", "DILRMP": "DILRMP_BASE_URL", "GeoServer": "GEOSERVER_URL",
    "Registration": "REGISTRATION_API_URL", "Notifications": "NOTIFICATION_GATEWAY_URL",
}
INTEGRATION_TOKEN_VARS = {
    "LRMS": "LRMS_API_TOKEN", "DILRMP": "DILRMP_API_TOKEN", "GeoServer": "GEOSERVER_API_TOKEN",
    "Registration": "REGISTRATION_API_TOKEN", "Notifications": "NOTIFICATION_GATEWAY_TOKEN",
}


def add_audit(db: Session, event_type: str, actor: str, action: str, document_id: str | None = None, details: str = "") -> None:
    append_and_commit(db, event_type, actor, action, document_id, details)


def add_notification(db: Session, title: str, message: str, level: str = "info", user_id: int | None = None) -> None:
    db.add(Notification(user_id=user_id, title=title, message=message, level=level))


# --- State scoping ------------------------------------------------------------------------
# A user with `state` set only ever sees, uploads, and manages that one state's data; a user
# with `state` None (national) is unrestricted. This is the single mechanism behind "a UP
# reviewer never sees Maharashtra records and vice versa" - every endpoint below that reads
# or writes Document/Parcel/RegistryFlag rows, or lists/creates User rows, goes through one
# of these three helpers rather than re-implementing the check inline.

def scope_documents(statement, user: User):
    state = effective_state(user)
    return statement.where(Document.state == state) if state else statement


def scope_parcels(statement, user: User):
    state = effective_state(user)
    return statement.where(Parcel.state == state) if state else statement


def scope_registry_flags(statement, user: User):
    state = effective_state(user)
    return statement.where(RegistryFlag.state == state) if state else statement


def _call_external_json(base_url: str, path: str, payload: dict | None, token: str = "", method: str = "POST") -> tuple[int, dict | None, str]:
    """Call an external connector and report what actually happened, instead of the
    unconditional 'not configured' this used to return regardless of the URL on file."""
    request = urllib.request.Request(
        base_url.rstrip("/") + path, data=json.dumps(payload).encode("utf-8") if payload is not None else None, method=method,
        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            raw = response.read()
            try:
                return response.status, (json.loads(raw) if raw else None), ""
            except json.JSONDecodeError:
                return response.status, None, "Connector response was not valid JSON."
    except urllib.error.HTTPError as exc:
        return exc.code, None, exc.read().decode("utf-8", "replace")[:500]
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return 0, None, str(exc)[:500]


def seed_system_data() -> None:
    with SessionLocal() as db:
        if not db.scalar(select(func.count()).select_from(User)):
            password = os.getenv("DEMO_PASSWORD", "Dhara@2026")
            # state=None is national access (every state); everyone else is fenced to their
            # one state - see scope_documents/scope_parcels/get_document_or_404. The two
            # Maharashtra accounts exist so "log in from a different state's employee list
            # and see only that state's records" is demoable without creating anyone first.
            users = [
                ("admin@dhara.gov.in", "Aditi Rao", "Administrator", None),
                ("priya@dhara.gov.in", "Priya Sharma", "Verification Officer", "Uttar Pradesh"),
                ("operator@dhara.gov.in", "Meera Singh", "Data Operator", "Uttar Pradesh"),
                ("auditor@dhara.gov.in", "Vikram Joshi", "Auditor", "Uttar Pradesh"),
                ("viewer@dhara.gov.in", "Public Records Viewer", "Viewer", "Uttar Pradesh"),
                ("mumbai.operator@dhara.gov.in", "Rahul Deshmukh", "Data Operator", "Maharashtra"),
                ("mumbai.reviewer@dhara.gov.in", "Anjali Kulkarni", "Verification Officer", "Maharashtra"),
            ]
            for username, display_name, role, state in users:
                db.add(User(username=username, display_name=display_name, role=role, state=state, password_hash=hash_password(password)))

        if not db.scalar(select(func.count()).select_from(Document)):
            samples = [
                ("LR-2026-04182", "Uttar Pradesh", "Rural", "Jamabandi Register · 1998", "Lucknow", "Hindi", 97.4, "Verified", "142/2A", "Mahesh Kumar Yadav", "Rampur"),
                ("LR-2026-04181", "Uttar Pradesh", "Rural", "Khasra Record · 2004", "Varanasi", "Hindi", 82.1, "Needs review", "88/1", "Sunita Devi", "Baragaon"),
                ("LR-2026-04180", "Uttar Pradesh", "Rural", "Mutation Register · 1987", "Prayagraj", "Urdu", 74.8, "Needs review", "207/4B", "Iqbal Ahmad Khan", "Sadar"),
                ("LR-2026-04179", "Uttar Pradesh", "Rural", "Khatauni · 2010", "Lucknow", "Hindi", 93.6, "Verified", "51/3", "Kamla Prasad", "Malihabad"),
                ("LR-2026-04177", "Uttar Pradesh", "Urban", "Registry Deed · 1995", "Prayagraj", "English", 96.2, "Verified", "319/2", "Anil Singh Chauhan", "Karchhana"),
                ("LR-2026-05201", "Maharashtra", "Rural", "Satbara (7/12) Extract · 2011", "Pune", "Marathi", 91.5, "Verified", "64/2", "Sunil Bhosale", "Hadapsar"),
                ("LR-2026-05202", "Maharashtra", "Urban", "Mutation Register · 2006", "Mumbai Suburban", "Marathi", 79.3, "Needs review", "12/A", "Neha Patil", "Andheri"),
            ]
            for record_id, state, category, doc_type, district, language, confidence, status, survey, owner, village in samples:
                document = Document(
                    id=record_id, filename=f"{record_id}.pdf", mime_type="application/pdf", state=state, category=category,
                    district=district, doc_type=doc_type, language=language, status=status, confidence=confidence,
                    ocr_engine="Imported legacy record", validation_issues="[]",
                )
                db.add(document)
                db.flush()
                field_values = [
                    ("Landowner name", owner, 98, True), ("Survey number", survey, 94, True), ("Khasra number", survey, 96, True),
                    ("Khata number", "KH-02491" if record_id == "LR-2026-04181" else "", 91 if record_id == "LR-2026-04181" else 0, record_id == "LR-2026-04181"),
                    ("Plot area", "1.37 hectare" if record_id == "LR-2026-04181" else "", 86 if record_id == "LR-2026-04181" else 0, record_id == "LR-2026-04181"),
                    ("Village", village, 93, True), ("Tehsil", "Pindra" if district == "Varanasi" else "", 88 if district == "Varanasi" else 0, district == "Varanasi"),
                    ("District", district, 99, True), ("Land classification", "Agricultural — Irrigated" if record_id == "LR-2026-04181" else "", 72 if record_id == "LR-2026-04181" else 0, False),
                    ("Ownership details", "Recorded tenure holder", 90, True),
                    ("Mutation reference", "MUT/2004/117" if record_id == "LR-2026-04181" else "", 68 if record_id == "LR-2026-04181" else 0, False),
                    ("Registration information", "REG/1995/3192" if "Registry" in doc_type else "", 92 if "Registry" in doc_type else 0, "Registry" in doc_type),
                ]
                for label, value, score, valid in field_values:
                    db.add(ExtractedField(document_id=record_id, label=label, value=value, original=value or "Not available", confidence=score, valid=valid, verified=status == "Verified"))
            add_audit(db, "approve", "Priya Sharma", "approved record LR-2026-04182", "LR-2026-04182")
            add_audit(db, "flag", "AI pipeline", "flagged fields in LR-2026-04181", "LR-2026-04181")
            add_audit(db, "map", "GIS service", "linked parcel 51/3 with cadastral map", "LR-2026-04179")

        # Keep legacy/imported records aligned with the current canonical schema.
        documents = db.scalars(select(Document).options(selectinload(Document.fields))).unique()
        for document in documents:
            existing_labels = {field.label for field in document.fields}
            for label in STANDARD_FIELD_LABELS:
                if label not in existing_labels:
                    db.add(ExtractedField(
                        document_id=document.id,
                        label=label,
                        value="",
                        original="Not available in imported record",
                        confidence=0,
                        valid=False,
                        verified=False,
                    ))

        if not db.scalar(select(func.count()).select_from(Parcel)):
            # Coordinates are scaled so each polygon's geometric area (see
            # validation._geometry_area_hectares) lands within the cross-modal check's
            # tolerance of the area_hectares stated below - the original placeholder
            # coordinates described parcels roughly 20x larger than their stated area,
            # which meant the demo data failed its own consistency check on day one.
            parcel_rows = [
                ("88/1", "Sunita Devi", 1.37, "Agricultural — Irrigated", "Verified", "LR-2026-04181", [[82.9238,25.5351],[82.9249,25.5354],[82.9251,25.5345],[82.9243,25.5341],[82.9237,25.5345],[82.9238,25.5351]]),
                ("88/2", "Ram Kumar", .84, "Agricultural", "Verified", None, [[82.9249,25.5354],[82.9259,25.5352],[82.9258,25.5344],[82.9251,25.5345],[82.9249,25.5354]]),
                ("89/1", "Mohan Lal", 1.12, "Agricultural", "Needs review", None, [[82.9237,25.5345],[82.9243,25.5341],[82.9241,25.5333],[82.9234,25.5334],[82.9232,25.5339],[82.9237,25.5345]]),
                ("89/2", "Village Commons", 2.08, "Fallow land", "Verified", None, [[82.9243,25.5341],[82.9251,25.5345],[82.9258,25.5344],[82.9256,25.5334],[82.9241,25.5333],[82.9243,25.5341]]),
                ("90", "Asha Devi", 1.62, "Agricultural", "Verified", None, [[82.9259,25.5352],[82.9267,25.5348],[82.9266,25.5338],[82.9256,25.5334],[82.9258,25.5344],[82.9259,25.5352]]),
                ("91/1", "Rakesh Singh", 1.09, "Orchard", "Verified", None, [[82.9234,25.5334],[82.9241,25.5333],[82.9244,25.5323],[82.9236,25.5321],[82.9230,25.5327],[82.9234,25.5334]]),
                ("91/2", "Shyam Narayan", 1.74, "Agricultural", "Needs review", None, [[82.9241,25.5333],[82.9256,25.5334],[82.9257,25.5324],[82.9244,25.5323],[82.9241,25.5333]]),
                ("92", "Iqbal Ahmad", 1.46, "Residential", "Verified", None, [[82.9256,25.5334],[82.9266,25.5338],[82.9268,25.5327],[82.9263,25.5321],[82.9257,25.5324],[82.9256,25.5334]]),
            ]
            for khasra, owner, area, classification, status, record_id, coordinates in parcel_rows:
                db.add(Parcel(khasra_number=khasra, owner=owner, area_hectares=area, classification=classification, status=status, village="Baragaon", tehsil="Pindra", district="Varanasi", record_id=record_id, geometry_geojson=json.dumps({"type": "Polygon", "coordinates": [coordinates]})))

        if not db.scalar(select(func.count()).select_from(RegistryFlag)):
            # A live example of validation._registry_flag_check actually blocking something:
            # LR-2026-04181 (khasra 88/1, Varanasi) is still "Needs review" - approving it
            # should fail until this mortgage is resolved via PATCH /api/registry-flags/{id}.
            db.add(RegistryFlag(
                state="Uttar Pradesh", district="Varanasi", khasra_number="88/1", flag_type="Mortgage",
                status="Active", reference="SBI/AGRI-LOAN/2024/8817", notes="Outstanding agricultural loan lien recorded against this khasra.",
                created_by="System seed",
            ))
            db.flush()
            flagged_document = db.scalar(select(Document).options(selectinload(Document.fields)).where(Document.id == "LR-2026-04181"))
            if flagged_document:
                flagged_document.validation_issues = json.dumps(validate_record(db, flagged_document))

        if not db.scalar(select(func.count()).select_from(Notification)):
            add_notification(db, "Verification queue", "Records with low-confidence fields are ready for review.", "warning")
            add_notification(db, "System ready", "Encrypted storage and the durable processing worker are operational.", "success")

        for job in db.scalars(select(ProcessingJob).where(ProcessingJob.status == "Running")):
            job.status = "Queued"
            job.stage = "Recovered after restart"
        for document in db.scalars(select(Document).where(Document.storage_name.is_not(None))):
            legacy_path = UPLOAD_DIR / str(document.storage_name)
            if legacy_path.exists() and not legacy_path.read_bytes().startswith(b"DHARA1"):
                content = legacy_path.read_bytes()
                encrypted_name = f"{secrets.token_hex(16)}.dhara"
                document.checksum_sha256 = encrypt_and_store(UPLOAD_DIR / encrypted_name, content)
                document.storage_name = encrypted_name
                legacy_path.unlink(missing_ok=True)
                add_audit(db, "security", "System migration", f"encrypted legacy source for {document.id}", document.id)
        db.commit()


def field_value(document: Document, label: str, fallback: str = "") -> str:
    return next((field.value for field in document.fields if field.label == label and field.value), fallback)


def generate_document_id(db: Session) -> str:
    year = datetime.now(timezone.utc).year
    while True:
        record_id = f"LR-{year}-{secrets.randbelow(90000) + 10000}"
        if db.get(Document, record_id) is None:
            return record_id


def relative_time(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    seconds = max(0, int((datetime.now(timezone.utc) - value).total_seconds()))
    if seconds < 60:
        return "Just now"
    if seconds < 3600:
        return f"{seconds // 60} min ago"
    if seconds < 86400:
        return f"{seconds // 3600} hr ago"
    return f"{seconds // 86400} days ago"


def serialize_document(document: Document) -> dict:
    village = field_value(document, "Village")
    try:
        issues = json.loads(document.validation_issues or "[]")
    except json.JSONDecodeError:
        issues = []
    return {
        "id": document.id,
        "owner": field_value(document, "Landowner name", "Awaiting extraction" if document.status == "Processing" else "Not detected"),
        "document": document.doc_type,
        "filename": document.filename,
        "location": f"{village}, {document.district}" if village else document.district,
        "district": document.district,
        "category": document.category,
        "survey": field_value(document, "Khasra number", "—"),
        "type": document.doc_type.split(" · ")[0],
        "language": document.language,
        "confidence": round(document.confidence, 1),
        "status": document.status,
        "updated": relative_time(document.updated_at),
        "created_at": document.created_at,
        "file_url": f"/api/documents/{document.id}/file" if document.storage_name else None,
        "ocr_engine": document.ocr_engine,
        "fields": [FieldOut.model_validate(field) for field in document.fields],
        "plot_rows": [PlotRowOut.model_validate(row) for row in document.plot_rows],
        "validation_issues": issues,
        "version": document.version,
        "batch_id": document.batch_id,
    }


def get_document_or_404(db: Session, document_id: str, user: User | None = None) -> Document:
    document = db.scalar(select(Document).options(selectinload(Document.fields)).where(Document.id == document_id))
    # A state-scoped user gets the same 404 for "exists in another state" as for "doesn't
    # exist" - not a 403 - so a UP reviewer can't even confirm a Maharashtra record ID is real.
    if not document or (user and effective_state(user) and document.state != effective_state(user)):
        raise HTTPException(status_code=404, detail="Record not found")
    return document


def add_revision(db: Session, document: Document, actor: str, action: str) -> None:
    snapshot = {"status": document.status, "confidence": document.confidence, "fields": {field.label: field.value for field in document.fields}}
    db.add(RecordRevision(document_id=document.id, version=document.version, actor=actor, action=action, snapshot_json=json.dumps(snapshot)))


def build_correction_lookup(db: Session, language: str) -> dict[tuple[str, str], str]:
    """(field_label, raw OCR value) -> the value a reviewer confirmed it should be, drawn
    from this language's FieldCorrection history - the feedback loop extract_fields reuses
    to resolve a recurring misread without a human correcting it twice."""
    rows = db.scalars(select(FieldCorrection).where(FieldCorrection.language == language).order_by(FieldCorrection.created_at))
    lookup: dict[tuple[str, str], str] = {}
    for row in rows:
        raw = row.predicted_value.strip()
        if raw:
            lookup[(row.field_label, raw)] = row.corrected_value
    return lookup


def process_document(document_id: str, db: Session) -> None:
    document = get_document_or_404(db, document_id)
    if not document.storage_name:
        raise ValueError("Source file is unavailable")
    encrypted_path = UPLOAD_DIR / document.storage_name
    with materialize_decrypted(encrypted_path, Path(document.filename).suffix) as source_path:
        text, engine_name, word_confidences = extract_text(source_path, document.mime_type, document.language)
    document.ocr_text = text
    document.ocr_engine = engine_name
    document.language = detect_language(text, document.language)
    corrections = build_correction_lookup(db, document.language)
    for result in extract_fields(text, document.district, word_confidences, engine_name, corrections):
        db.add(ExtractedField(document_id=document.id, **result))
    db.flush()
    scores = [field.confidence for field in document.fields]
    document.confidence = sum(scores) / len(scores) if scores else 0
    document.status = "Needs review"
    document.updated_at = datetime.now(timezone.utc)
    issues = validate_record(db, document)
    document.validation_issues = json.dumps(issues)
    add_audit(db, "flag" if issues else "process", "AI pipeline", f"processed {document.filename}; {len(issues)} validation issues", document.id, f"Engine: {engine_name}")
    if issues:
        add_notification(db, "Record needs review", f"{document.id} has {len(issues)} validation issues.", "warning")


def process_next_job() -> bool:
    with SessionLocal() as db:
        job = db.scalar(select(ProcessingJob).where(ProcessingJob.status == "Queued").order_by(ProcessingJob.created_at).limit(1))
        if not job:
            return False
        job.status = "Running"
        job.stage = "OCR and field extraction"
        job.attempts += 1
        job.updated_at = datetime.now(timezone.utc)
        db.commit()
        try:
            process_document(job.document_id, db)
            job.status = "Completed"
            job.stage = "Ready for verification"
        except Exception as exc:
            document = db.get(Document, job.document_id)
            if document:
                document.status = "Needs review"
                document.ocr_engine = "Processing error"
            job.status = "Failed" if job.attempts >= 3 else "Queued"
            job.stage = "Retry queued" if job.status == "Queued" else "Manual intervention required"
            job.error = str(exc)[:1000]
            add_audit(db, "flag", "AI pipeline", f"processing failed for {job.document_id}", job.document_id, job.error)
        job.updated_at = datetime.now(timezone.utc)
        db.commit()
        return True


async def job_worker() -> None:
    while True:
        worked = await asyncio.to_thread(process_next_job)
        await asyncio.sleep(.35 if worked else 1.25)


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(engine)
    upgrade_schema(engine)
    seed_system_data()
    with SessionLocal() as db:
        rebuild_chain(db)
        db.commit()
    # This legacy queue polls with a fresh DB session every ~0.35-1.25s, which is
    # harmless against local SQLite but opens/exercises real connections fast enough
    # to exhaust a pooled remote database (confirmed: hangs against Neon). It's also
    # dead weight generally - OCR now runs client-side, not through this queue.
    worker = None if os.getenv("VERCEL") or not DATABASE_URL.startswith("sqlite") else asyncio.create_task(job_worker())
    try:
        yield
    finally:
        if worker:
            worker.cancel()
            try:
                await worker
            except asyncio.CancelledError:
                pass


if os.getenv("VERCEL"):
    Base.metadata.create_all(engine)
    upgrade_schema(engine)
    seed_system_data()
    with SessionLocal() as _db:
        rebuild_chain(_db)
        _db.commit()


app = FastAPI(title="Dhara Land Records API", description="Secure document intake, extraction, validation, verification, GIS, and audit API.", version="0.3.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

rate_windows: dict[str, deque[float]] = defaultdict(deque)


@app.middleware("http")
async def security_and_rate_limit(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        now = time.monotonic()
        key = f"{request.client.host if request.client else 'local'}:{request.url.path == '/api/auth/login'}"
        window = rate_windows[key]
        while window and now - window[0] > 60:
            window.popleft()
        limit = 20 if request.url.path == "/api/auth/login" else 300
        if len(window) >= limit:
            return JSONResponse({"detail": "Rate limit exceeded. Try again shortly."}, status_code=429)
        window.append(now)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(self)"
    return response


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "service": "dhara-api", "version": app.version, "queue": "database-backed", "storage": "AES-256-GCM"}


@app.post("/api/auth/login", response_model=TokenOut)
def login(credentials: LoginRequest, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.username == credentials.username.casefold().strip()))
    if not user or not user.active or not verify_password(credentials.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    portal_state = credentials.portal_state.strip() if credentials.portal_state else None
    # Not a mapped column - see security.get_current_user/effective_state. Set here too so the
    # very first response (before any token round-trip) already reflects it.
    user.session_state = portal_state
    add_audit(db, "login", user.display_name, "signed in to Dhara" + (f" via the {portal_state} portal" if portal_state else ""))
    db.commit()
    return TokenOut(
        access_token=create_access_token(user, portal_state=portal_state),
        user=UserOut(username=user.username, display_name=user.display_name, role=user.role, state=effective_state(user)),
    )


@app.get("/api/auth/me", response_model=UserOut)
def current_user(user: User = Depends(get_current_user)):
    return UserOut(username=user.username, display_name=user.display_name, role=user.role, state=effective_state(user))


@app.get("/api/users", response_model=list[AdminUserOut])
def list_users(db: Session = Depends(get_db), administrator: User = Depends(require_roles("Administrator"))):
    # A state-scoped administrator (e.g. a "Uttar Pradesh admin") manages only that state's
    # staff; a national administrator (state is None) manages everyone, across every state.
    statement = select(User).order_by(User.display_name)
    if effective_state(administrator):
        statement = statement.where(User.state == effective_state(administrator))
    return list(db.scalars(statement))


@app.post("/api/users", response_model=AdminUserOut, status_code=201)
def create_user(payload: UserCreate, db: Session = Depends(get_db), administrator: User = Depends(require_roles("Administrator"))):
    roles = set(READ_ROLES)
    if payload.role not in roles:
        raise HTTPException(status_code=422, detail="Unknown role")
    state = effective_state(administrator) or (payload.state.strip() if payload.state else None) or None
    if effective_state(administrator) and payload.state and payload.state.strip() != effective_state(administrator):
        raise HTTPException(status_code=403, detail="You can only create users within your own state")
    username = payload.username.casefold().strip()
    if db.scalar(select(User).where(User.username == username)):
        raise HTTPException(status_code=409, detail="A user with this email already exists")
    user = User(username=username, display_name=payload.display_name.strip(), role=payload.role, state=state, password_hash=hash_password(payload.password))
    db.add(user)
    db.flush()
    add_audit(db, "security", administrator.display_name, f"created user {username} with role {payload.role}" + (f" in {state}" if state else ""))
    db.commit()
    db.refresh(user)
    return user


@app.patch("/api/users/{user_id}", response_model=AdminUserOut)
def update_user(user_id: int, payload: UserUpdate, db: Session = Depends(get_db), administrator: User = Depends(require_roles("Administrator"))):
    user = db.get(User, user_id)
    if not user or (effective_state(administrator) and effective_state(user) != effective_state(administrator)):
        raise HTTPException(status_code=404, detail="User not found")
    changes = payload.model_dump(exclude_unset=True)
    if changes.get("role") and changes["role"] not in set(READ_ROLES):
        raise HTTPException(status_code=422, detail="Unknown role")
    if effective_state(administrator) and "state" in changes and changes["state"] != effective_state(administrator):
        raise HTTPException(status_code=403, detail="You can only assign users to your own state")
    if user.id == administrator.id and changes.get("active") is False:
        raise HTTPException(status_code=409, detail="You cannot deactivate your own account")
    for key, value in changes.items():
        setattr(user, key, value)
    add_audit(db, "security", administrator.display_name, f"updated user {user.username}: {', '.join(changes)}")
    db.commit()
    db.refresh(user)
    return user


@app.get("/api/documents", response_model=list[DocumentOut])
def list_documents(status: str | None = None, search: str | None = None, db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    statement = scope_documents(select(Document).options(selectinload(Document.fields)).order_by(Document.created_at.desc()), user)
    if status:
        statement = statement.where(Document.status == status)
    documents = list(db.scalars(statement).unique())
    if search:
        term = search.casefold()
        documents = [doc for doc in documents if term in f"{doc.id} {doc.filename} {doc.district} {' '.join(field.value for field in doc.fields)}".casefold()]
    return [serialize_document(document) for document in documents]


@app.get("/api/documents/{document_id}", response_model=DocumentOut)
def get_document(document_id: str, db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    return serialize_document(get_document_or_404(db, document_id, user))


async def persist_upload(file: UploadFile, state: str, district: str, category: str, document_type: str, language: str, actor: User, db: Session) -> Document:
    # A state-scoped operator's own state always wins over whatever the client sent - the
    # upload form locks/hides this field client-side for such users, but the server is the
    # actual boundary (a tampered request must not be able to write into another state).
    state = effective_state(actor) or state
    category = category if category in ("Urban", "Rural") else "Rural"
    original_name = re.sub(r"[\x00-\x1f\x7f]+", "_", Path(file.filename or "upload").name).strip()[:255] or "upload"
    extension = Path(original_name).suffix.lower()
    mime_type = file.content_type or "application/octet-stream"
    if extension not in ALLOWED_EXTENSIONS or mime_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=415, detail="Only PDF, PNG, JPG, and TIFF files are supported")
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds the 50 MB limit")
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    try:
        validate_document(content, extension)
        scan_result = malware_scan(content)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    record_id = generate_document_id(db)
    storage_name = f"{secrets.token_hex(16)}.dhara"
    checksum = encrypt_and_store(UPLOAD_DIR / storage_name, content)
    document = Document(
        id=record_id, filename=original_name, storage_name=storage_name, mime_type=mime_type, file_size=len(content),
        state=state, district=district, category=category, doc_type=document_type, language=language, status="Processing", confidence=0,
        ocr_engine="Queued", checksum_sha256=checksum, validation_issues="[]",
    )
    db.add(document)
    db.flush()
    db.add(ProcessingJob(document_id=record_id, status="Queued", stage="Awaiting worker"))
    add_audit(db, "upload", actor.display_name, f"uploaded {original_name}", record_id, f"{len(content)} bytes; malware={scan_result}; sha256={checksum}")
    db.commit()
    return get_document_or_404(db, record_id)


@app.post("/api/documents", response_model=DocumentOut, status_code=201)
async def upload_document(
    file: UploadFile = File(...), state: str = Form("Uttar Pradesh"), district: str = Form("Unassigned"), category: str = Form("Rural"),
    document_type: str = Form("Land record"), language: str = Form("Auto-detect"),
    db: Session = Depends(get_db), user: User = Depends(require_roles(*UPLOAD_ROLES)),
):
    return serialize_document(await persist_upload(file, state, district, category, document_type, language, user, db))


@app.post("/api/documents/batch", response_model=list[DocumentOut], status_code=201)
async def upload_batch(
    files: list[UploadFile] = File(...), state: str = Form("Uttar Pradesh"), district: str = Form("Unassigned"), category: str = Form("Rural"),
    document_type: str = Form("Land record"), language: str = Form("Auto-detect"),
    db: Session = Depends(get_db), user: User = Depends(require_roles(*UPLOAD_ROLES)),
):
    if len(files) > MAX_BATCH_FILES:
        raise HTTPException(status_code=413, detail=f"A batch may contain at most {MAX_BATCH_FILES} files")
    records = []
    for file in files:
        records.append(serialize_document(await persist_upload(file, state, district, category, document_type, language, user, db)))
    return records


def build_extracted_fields(payload: ExtractionSubmission, plot: PlotRowIn | None, plot_label: str | None) -> list[ExtractedField]:
    submitted = {field.label: field for field in payload.fields if field.label in STANDARD_FIELD_LABELS}
    overrides = {"Khata number": plot.khata.strip(), "Khasra number": plot.khasra.strip(), "Plot area": plot.area.strip()} if plot else {}
    fields = []
    for label in STANDARD_FIELD_LABELS:
        if label in overrides:
            value = overrides[label]
            fields.append(ExtractedField(label=label, value=value, original=(plot_label or "Plot table row")[:500], confidence=95.0 if value else 0, valid=bool(value), verified=False))
            continue
        field = submitted.get(label)
        value = field.value.strip() if field else ""
        fields.append(ExtractedField(
            label=label, value=value, original=(field.original.strip() if field else "Not detected")[:500],
            confidence=field.confidence if value and field else 0, valid=bool(value), verified=False,
        ))
    return fields


def set_plot_rows(document: Document, rows: list[PlotRowIn]) -> None:
    document.plot_rows.clear()
    for index, row in enumerate(rows):
        document.plot_rows.append(PlotRow(
            row_index=index, khata=row.khata.strip(), khasra=row.khasra.strip(),
            area=row.area.strip(), rent=row.rent.strip(), cess=row.cess.strip(),
        ))


def finalize_extraction(db: Session, document: Document, payload: ExtractionSubmission, user: User, action: str) -> list[dict]:
    db.flush()
    detected = [field for field in document.fields if field.value]
    field_confidence = sum(field.confidence for field in detected) / len(detected) if detected else 0
    document.confidence = round(payload.confidence * .35 + field_confidence * .65, 2)
    document.ocr_text = payload.text
    document.ocr_engine = payload.engine
    document.language = payload.language
    document.status = "Needs review"
    document.version += 1
    document.updated_at = datetime.now(timezone.utc)
    issues = validate_record(db, document)
    for index, warning in enumerate(payload.warnings[:10], start=1):
        issues.append({"code": f"ocr_warning_{index}", "field": "Document", "severity": "warning", "message": warning[:300]})
    document.validation_issues = json.dumps(issues)
    job = db.scalar(select(ProcessingJob).where(ProcessingJob.document_id == document.id))
    if job:
        job.status = "Completed"
        job.stage = "Verification ready"
        job.error = ""
        job.attempts += 1
        job.updated_at = datetime.now(timezone.utc)
    add_revision(db, document, user.display_name, action)
    add_audit(db, "process", user.display_name, f"extracted {len(detected)} of {len(STANDARD_FIELD_LABELS)} fields", document.id, f"{payload.engine}; {payload.pages} page(s); {document.confidence:.1f}% confidence")
    add_notification(db, "OCR processing complete", f"{document.id} is ready for assisted verification.", "warning" if issues else "success")
    return issues


@app.post("/api/documents/{document_id}/extraction", response_model=list[DocumentOut])
def submit_browser_extraction(
    document_id: str, payload: ExtractionSubmission, db: Session = Depends(get_db), user: User = Depends(require_roles(*UPLOAD_ROLES)),
):
    document = get_document_or_404(db, document_id, user)
    plot_rows = payload.plot_rows
    total_plots = len(plot_rows)
    multi_plot = total_plots > 1

    first_plot = plot_rows[0] if plot_rows else None
    first_label = f"Plot table (plot 1 of {total_plots})" if multi_plot else "Plot table row" if plot_rows else None
    document.fields = build_extracted_fields(payload, first_plot, first_label)
    set_plot_rows(document, plot_rows)
    document.batch_id = document.id if multi_plot else None
    finalize_extraction(db, document, payload, user, "Completed browser OCR and field extraction")

    # A register listing several plots (Khata/Khasra rows) means several distinct
    # landholdings, not one - give each of the remaining plots its own Document, sharing
    # the same uploaded source file and document-wide fields (owner, village, district, ...)
    # but with its own Khata/Khasra/Plot area and its own place in the verification queue.
    created = [document]
    for offset, plot in enumerate(plot_rows[1:], start=2):
        sibling = Document(
            id=generate_document_id(db), filename=document.filename, storage_name=document.storage_name,
            mime_type=document.mime_type, file_size=document.file_size, state=document.state, category=document.category,
            district=document.district, doc_type=document.doc_type, status="Processing", confidence=0,
            checksum_sha256=document.checksum_sha256, validation_issues="[]", batch_id=document.id, version=0,
        )
        db.add(sibling)
        db.flush()
        sibling.fields = build_extracted_fields(payload, plot, f"Plot table (plot {offset} of {total_plots})")
        set_plot_rows(sibling, plot_rows)
        finalize_extraction(db, sibling, payload, user, f"Created from a {total_plots}-plot register (plot {offset} of {total_plots})")
        created.append(sibling)

    db.commit()
    return [serialize_document(get_document_or_404(db, doc.id, user)) for doc in created]


@app.post("/api/documents/{document_id}/extraction/fail", response_model=DocumentOut)
def fail_browser_extraction(
    document_id: str, payload: ExtractionFailure, db: Session = Depends(get_db), user: User = Depends(require_roles(*UPLOAD_ROLES)),
):
    document = get_document_or_404(db, document_id, user)
    document.status = "Needs review"
    document.confidence = 0
    document.ocr_engine = "OCR unavailable · manual verification"
    document.validation_issues = json.dumps([{"code": "ocr_review_required", "field": "Document", "severity": "warning", "message": "Automated OCR could not complete; the securely stored source requires manual verification."}])
    document.updated_at = datetime.now(timezone.utc)
    job = db.scalar(select(ProcessingJob).where(ProcessingJob.document_id == document.id))
    if job:
        job.status = "Failed"
        job.stage = "Manual verification required"
        job.error = payload.message
        job.attempts += 1
        job.updated_at = datetime.now(timezone.utc)
    add_revision(db, document, user.display_name, "OCR routed to manual verification")
    add_audit(db, "flag", user.display_name, "online OCR requires manual review", document.id, payload.message)
    db.commit()
    return serialize_document(get_document_or_404(db, document.id, user))


@app.get("/api/documents/{document_id}/processing")
def processing_status(document_id: str, db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    get_document_or_404(db, document_id, user)
    job = db.scalar(select(ProcessingJob).where(ProcessingJob.document_id == document_id))
    if not job:
        return {"document_id": document_id, "status": "Not tracked", "stage": "Imported record", "progress": 100}
    progress = 100 if job.status in {"Completed", "Failed"} else 55 if job.status == "Running" else 10
    return {"document_id": document_id, "status": job.status, "stage": job.stage, "progress": progress, "attempts": job.attempts, "error": job.error}


@app.get("/api/documents/{document_id}/file")
def get_document_file(document_id: str, db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    document = get_document_or_404(db, document_id, user)
    if not document.storage_name:
        raise HTTPException(status_code=404, detail="Source file is unavailable for this imported record")
    path = (UPLOAD_DIR / document.storage_name).resolve()
    # The local-directory containment/existence check only makes sense for the local-
    # filesystem fallback; a Blob-backed read validates existence itself (BlobNotFoundError
    # surfaces as the ValueError caught below).
    if not BLOB_ENABLED and (path.parent != UPLOAD_DIR.resolve() or not path.exists()):
        raise HTTPException(status_code=404, detail="Source file not found")
    try:
        content = read_and_decrypt(path)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Source file not found") from exc
    if document.checksum_sha256 and not secrets.compare_digest(hashlib.sha256(content).hexdigest(), document.checksum_sha256):
        raise HTTPException(status_code=500, detail="Stored file checksum does not match its protected record")
    headers = {"Content-Disposition": f'inline; filename="{document.filename.replace(chr(34), "")}"', "Cache-Control": "private, no-store"}
    return StreamingResponse(io.BytesIO(content), media_type=document.mime_type, headers=headers)


@app.patch("/api/documents/{document_id}/fields/{field_id}", response_model=DocumentOut)
def update_field(document_id: str, field_id: int, update: FieldUpdate, db: Session = Depends(get_db), user: User = Depends(require_roles(*REVIEW_ROLES))):
    document = get_document_or_404(db, document_id, user)
    field = next((item for item in document.fields if item.id == field_id), None)
    if not field:
        raise HTTPException(status_code=404, detail="Extracted field not found")
    old_value = field.value
    corrected_value = update.value.strip()
    if corrected_value == old_value:
        return serialize_document(document)
    db.add(FieldCorrection(
        document_id=document.id,
        field_label=field.label,
        predicted_value=old_value,
        corrected_value=corrected_value,
        source_excerpt=field.original,
        language=document.language,
        actor=user.display_name,
    ))
    field.value = corrected_value
    field.confidence = 100
    field.valid = bool(field.value)
    field.verified = True
    document.confidence = sum(item.confidence for item in document.fields) / len(document.fields)
    document.updated_at = datetime.now(timezone.utc)
    document.version += 1
    document.validation_issues = json.dumps(validate_record(db, document))
    add_audit(db, "edit", user.display_name, f"updated {field.label} in {document.id}", document.id, f"{old_value!r} → {field.value!r}; version={document.version}")
    add_revision(db, document, user.display_name, f"Corrected {field.label}")
    db.commit()
    return serialize_document(get_document_or_404(db, document_id, user))


@app.post("/api/documents/{document_id}/validate", response_model=DocumentOut)
def validate_document_record(document_id: str, db: Session = Depends(get_db), user: User = Depends(require_roles(*REVIEW_ROLES))):
    document = get_document_or_404(db, document_id, user)
    issues = validate_record(db, document)
    document.validation_issues = json.dumps(issues)
    add_audit(db, "validate", user.display_name, f"validated {document.id}; {len(issues)} issues", document.id)
    db.commit()
    return serialize_document(get_document_or_404(db, document_id, user))


@app.post("/api/documents/{document_id}/approve", response_model=DocumentOut)
def approve_document(document_id: str, _: ApprovalRequest, db: Session = Depends(get_db), user: User = Depends(require_roles(*REVIEW_ROLES))):
    document = get_document_or_404(db, document_id, user)
    issues = validate_record(db, document)
    blocking = [issue for issue in issues if issue.get("severity") == "error"]
    document.validation_issues = json.dumps(issues)
    if blocking:
        db.commit()
        raise HTTPException(status_code=409, detail={"message": "Resolve required validation errors before approval", "issues": blocking})
    document.status = "Verified"
    document.updated_at = datetime.now(timezone.utc)
    document.version += 1
    for field in document.fields:
        field.verified = True
    add_audit(db, "approve", user.display_name, f"approved record {document.id}", document.id, f"version={document.version}")
    add_revision(db, document, user.display_name, "Approved record")
    add_notification(db, "Record approved", f"{document.id} was approved by {user.display_name}.", "success")
    db.commit()
    return serialize_document(get_document_or_404(db, document_id, user))


@app.post("/api/documents/{document_id}/reject", response_model=DocumentOut)
def reject_document(document_id: str, approval: ApprovalRequest, db: Session = Depends(get_db), user: User = Depends(require_roles(*REVIEW_ROLES))):
    document = get_document_or_404(db, document_id, user)
    document.status = "Rejected"
    document.updated_at = datetime.now(timezone.utc)
    document.version += 1
    add_audit(db, "reject", user.display_name, f"rejected record {document.id}", document.id, approval.actor)
    add_revision(db, document, user.display_name, "Rejected record")
    db.commit()
    return serialize_document(get_document_or_404(db, document_id, user))


@app.get("/api/audit", response_model=list[AuditOut])
def list_audit(limit: int = 100, document_id: str | None = None, db: Session = Depends(get_db), user: User = Depends(require_roles(*AUDIT_ROLES))):
    statement = select(AuditEvent).order_by(AuditEvent.created_at.desc()).limit(min(max(limit, 1), 500))
    if document_id:
        statement = statement.where(AuditEvent.document_id == document_id)
    if effective_state(user):
        # System-level events (no document_id, e.g. logins) stay visible; document-linked
        # events are scoped to documents in this user's own state.
        in_state_ids = select(Document.id).where(Document.state == effective_state(user))
        statement = statement.where((AuditEvent.document_id.is_(None)) | (AuditEvent.document_id.in_(in_state_ids)))
    return list(db.scalars(statement))


@app.get("/api/audit/integrity")
def audit_integrity(db: Session = Depends(get_db), _: User = Depends(require_roles("Administrator", "Auditor"))):
    valid, events_checked = verify_chain(db)
    return {"valid": valid, "events_checked": events_checked, "algorithm": "HMAC-SHA256 hash chain"}


@app.get("/api/documents/{document_id}/versions")
def document_versions(document_id: str, db: Session = Depends(get_db), user: User = Depends(require_roles(*AUDIT_ROLES))):
    get_document_or_404(db, document_id, user)
    revisions = db.scalars(select(RecordRevision).where(RecordRevision.document_id == document_id).order_by(RecordRevision.version.desc()))
    return [{"version": revision.version, "actor": revision.actor, "action": revision.action, "snapshot": json.loads(revision.snapshot_json), "created_at": revision.created_at} for revision in revisions]


@app.get("/api/integrations")
def integration_status(_: User = Depends(require_roles("Administrator"))):
    integrations = [
        ("LRMS", "LRMS_BASE_URL", "Land Records Management System"),
        ("DILRMP", "DILRMP_BASE_URL", "Digital India Land Records Modernization Programme"),
        ("GeoServer", "GEOSERVER_URL", "Authoritative cadastral and GIS layers"),
        ("Registration", "REGISTRATION_API_URL", "Registration and deed verification"),
        ("Notifications", "NOTIFICATION_GATEWAY_URL", "Government SMS and email gateway"),
        ("Grafana", "GRAFANA_DASHBOARD_URL", "Embedded analytics dashboard"),
    ]
    return [{
        "key": key,
        "name": name,
        "configured": bool(os.getenv(variable)),
        "base_url": os.getenv(variable, ""),
        "configuration_variable": variable,
    } for key, variable, name in integrations]


@app.get("/api/integrations/grafana")
def grafana_status(_: User = Depends(require_roles(*AUDIT_ROLES))):
    # A public Grafana dashboard is just a URL - no token exchange, no service-account
    # credentials to manage server-side. See GRAFANA_DASHBOARD_URL in project notes for
    # what "public dashboard" trades away (anyone with the link can view it, no Grafana
    # login) in exchange for needing zero backend integration code.
    dashboard_url = os.getenv("GRAFANA_DASHBOARD_URL", "")
    if not dashboard_url:
        return {"configured": False, "message": "Grafana is not connected. Set GRAFANA_DASHBOARD_URL to a public dashboard link."}
    return {"configured": True, "dashboard_url": dashboard_url}


@app.post("/api/integrations/{key}/test")
def test_integration(key: str, db: Session = Depends(get_db), user: User = Depends(require_roles("Administrator"))):
    base_url = os.getenv(INTEGRATION_URL_VARS.get(key, ""), "")
    if not base_url:
        return {"key": key, "connected": False, "status": 503, "message": "External endpoint not configured. Set connector URL in environment."}
    status, _body, error = _call_external_json(base_url, "/health", None, os.getenv(INTEGRATION_TOKEN_VARS.get(key, ""), ""), method="GET")
    connected = 200 <= status < 300
    add_audit(db, "sync", user.display_name, f"tested integration {key}", None, f"status={status}" + (f"; {error}" if error else ""))
    db.commit()
    return {"key": key, "connected": connected, "status": status, "message": error or "Connector responded."}


@app.post("/api/integrations/{key}/sync/{document_id}")
def sync_integration(key: str, document_id: str, db: Session = Depends(get_db), user: User = Depends(require_roles("Administrator", "Verification Officer"))):
    base_url = os.getenv(INTEGRATION_URL_VARS.get(key, ""), "")
    if not base_url:
        return {"key": key, "record_id": document_id, "synchronized": False, "status": 503, "message": "External endpoint not configured."}
    document = get_document_or_404(db, document_id, user)
    status, body, error = _call_external_json(base_url, "/records", canonical_record_payload(document), os.getenv(INTEGRATION_TOKEN_VARS.get(key, ""), ""))
    synchronized = 200 <= status < 300
    add_audit(db, "sync", user.display_name, f"synchronized {document_id} with {key}", document_id, f"status={status}" + (f"; {error}" if error else ""))
    db.commit()
    return {"key": key, "record_id": document_id, "synchronized": synchronized, "status": status, "message": error or "Accepted by connector.", "response": body}


@app.get("/api/model/metrics")
def model_metrics(db: Session = Depends(get_db), user: User = Depends(require_roles(*AUDIT_ROLES))):
    docs = db.execute(
        scope_documents(
            select(
                Document.language,
                func.count().label("records"),
                func.round(func.avg(Document.confidence), 2).label("average_confidence"),
                func.sum(case((Document.status == "Verified", 1), else_=0)).label("verified"),
            ), user,
        ).group_by(Document.language).order_by(func.count().desc())
    ).all()
    lang_perf = [
        {"language": row.language, "records": row.records, "average_confidence": float(row.average_confidence or 0), "verified": int(row.verified or 0)}
        for row in docs
    ]
    # FieldCorrection has no state column of its own - scope through the document it belongs to.
    state_filter = FieldCorrection.document_id.in_(select(Document.id).where(Document.state == effective_state(user))) if effective_state(user) else True
    corrections_query = db.execute(
        select(FieldCorrection.field_label, func.count().label("corrections"))
        .where(state_filter)
        .group_by(FieldCorrection.field_label)
        .order_by(func.count().desc())
    ).all()
    corr_freq = [{"field_label": row.field_label, "corrections": row.corrections} for row in corrections_query]
    # A "learned pattern" is a (field, language, outcome) a reviewer has confirmed at least
    # ADAPTIVE_THRESHOLD times - this is the same signal extract_fields already acts on for
    # any single confirmed correction; the threshold here is only about what is common enough
    # to report as a trend, not a gate on reuse itself.
    learned_query = db.execute(
        select(FieldCorrection.field_label, FieldCorrection.language, FieldCorrection.corrected_value, func.count().label("occurrences"))
        .where(state_filter)
        .group_by(FieldCorrection.field_label, FieldCorrection.language, FieldCorrection.corrected_value)
        .having(func.count() >= ADAPTIVE_THRESHOLD)
        .order_by(func.count().desc())
    ).all()
    learned = [
        {"field_label": row.field_label, "language": row.language, "corrected_value": row.corrected_value, "occurrences": row.occurrences}
        for row in learned_query
    ]
    return {
        "language_performance": lang_perf,
        "correction_frequency": corr_freq,
        "learned_patterns": learned,
        "learned_patterns_message": None if learned else f"No pattern has been confirmed {ADAPTIVE_THRESHOLD}+ times yet - corrections are reused after a single confirmation, but need {ADAPTIVE_THRESHOLD} to be reported here as a trend.",
        "adaptive_threshold": ADAPTIVE_THRESHOLD,
        "mechanism": "Human-verified correction memory with language- and field-specific reuse",
    }


@app.get("/api/auth/oidc/status")
def oidc_status():
    issuer = os.getenv("OIDC_ISSUER")
    return {"configured": bool(issuer), "provider": "Government Single Sign-On" if issuer else None}


@app.post("/api/auth/oidc/start")
def oidc_start():
    raise HTTPException(status_code=501, detail="Government SSO endpoint requires OIDC_ISSUER configuration.")


@app.post("/api/auth/oidc/complete")
def oidc_complete():
    raise HTTPException(status_code=501, detail="Government SSO endpoint requires OIDC_ISSUER configuration.")


citizen_store: dict[str, dict] = {}


@app.post("/api/citizen/requests")
async def submit_citizen_request(request: Request, db: Session = Depends(get_db)):
    payload = await request.json()
    req_id = f"CR-{datetime.now(timezone.utc).year}-{secrets.randbelow(90000) + 10000}"
    token = secrets.token_hex(16)
    data = {
        "id": req_id,
        "request_id": req_id,
        "tracking_token": token,
        "request_type": payload.get("request_type", "Certified copy"),
        "record_id": payload.get("record_id"),
        "applicant_name": payload.get("applicant_name", ""),
        "status": "Submitted",
        "resolution": "Application logged and queued for departmental verification.",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    citizen_store[f"{req_id}:{token}"] = data
    citizen_store[req_id] = data
    add_audit(db, "citizen", "Citizen Portal", f"submitted {data['request_type']} {req_id}", data.get("record_id"))
    add_notification(db, "Citizen service request", f"{req_id}: {data['request_type']}", "info")
    db.commit()
    return data


@app.get("/api/citizen/requests/{request_id}")
def get_citizen_request(request_id: str, token: str = ""):
    key = f"{request_id}:{token}" if token else request_id
    if key in citizen_store:
        return citizen_store[key]
    if request_id in citizen_store:
        item = dict(citizen_store[request_id])
        item.pop("tracking_token", None)
        return item
    return {
        "id": request_id,
        "request_id": request_id,
        "status": "In review",
        "resolution": "Your request is currently being processed by the revenue authorities.",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/api/parcels/import")
async def import_parcels(request: Request, db: Session = Depends(get_db), user: User = Depends(require_roles("Administrator", "Verification Officer"))):
    data = await request.json()
    features = data.get("features", [])
    count = 0
    for feature in features:
        props = feature.get("properties", {})
        khasra = props.get("khasra")
        if not khasra:
            continue
        geom = feature.get("geometry", {})
        parcel = Parcel(
            khasra_number=str(khasra),
            owner=props.get("owner", "Not detected"),
            area_hectares=float(props.get("area", 1.0)),
            classification=props.get("classification", "Agricultural"),
            status=props.get("status", "Needs review"),
            # A state-scoped importer's own state wins over whatever the file says, same as
            # a document upload - the file's own "state" property is only honored for a
            # national (unscoped) importer.
            state=effective_state(user) or props.get("state", "Uttar Pradesh"),
            category=props.get("category") if props.get("category") in ("Urban", "Rural") else "Rural",
            village=props.get("village", "Baragaon"),
            tehsil=props.get("tehsil", "Pindra"),
            district=props.get("district", "Varanasi"),
            record_id=props.get("record_id"),
            geometry_geojson=json.dumps(geom),
        )
        db.add(parcel)
        count += 1
    db.commit()
    return {"imported": count}


def canonical_record_payload(document: Document) -> dict:
    values = {field.label: field.value for field in document.fields}
    return {
        "schema": "https://dhara.gov.in/schemas/land-record/v1",
        "record_id": document.id,
        "record_version": document.version,
        "status": document.status,
        "jurisdiction": {"state": document.state, "district": document.district, "tehsil": values.get("Tehsil", ""), "village": values.get("Village", "")},
        "identifiers": {"survey_number": values.get("Survey number", ""), "khasra_number": values.get("Khasra number", ""), "khata_number": values.get("Khata number", "")},
        "ownership": {"landowner": values.get("Landowner name", ""), "details": values.get("Ownership details", "")},
        "parcel": {"area": values.get("Plot area", ""), "classification": values.get("Land classification", "")},
        "transactions": {"mutation_reference": values.get("Mutation reference", ""), "registration_information": values.get("Registration information", "")},
        "provenance": {"source_filename": document.filename, "sha256": document.checksum_sha256, "ocr_engine": document.ocr_engine, "confidence": document.confidence, "updated_at": document.updated_at.isoformat()},
    }


@app.get("/api/integration/records/{document_id}")
def interoperable_record(document_id: str, db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    document = get_document_or_404(db, document_id, user)
    return JSONResponse(canonical_record_payload(document), headers={"X-Dhara-Schema-Version": "1"})


@app.get("/api/stats", response_model=StatsOut)
def get_stats(db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    total = db.scalar(scope_documents(select(func.count()).select_from(Document), user)) or 0
    needs_review = db.scalar(scope_documents(select(func.count()).select_from(Document).where(Document.status == "Needs review"), user)) or 0
    verified = db.scalar(scope_documents(select(func.count()).select_from(Document).where(Document.status == "Verified"), user)) or 0
    processing = db.scalar(scope_documents(select(func.count()).select_from(Document).where(Document.status == "Processing"), user)) or 0
    average = db.scalar(scope_documents(select(func.avg(Document.confidence)), user)) or 0
    district_rows = db.execute(scope_documents(select(Document.district, func.count()), user).group_by(Document.district).order_by(func.count().desc())).all()
    today = datetime.now(timezone.utc).date()
    documents = list(db.scalars(scope_documents(select(Document), user)))
    daily_volume = [{"date": (today - timedelta(days=offset)).isoformat(), "count": sum(1 for document in documents if document.created_at.date() == today - timedelta(days=offset))} for offset in range(13, -1, -1)]
    return StatsOut(total_records=total, needs_review=needs_review, verified=verified, processing=processing, average_confidence=round(float(average), 1), district_progress=[{"name": name, "processed": count} for name, count in district_rows], daily_volume=daily_volume)


def parcel_feature(parcel: Parcel) -> dict:
    return {"type": "Feature", "id": parcel.id, "geometry": json.loads(parcel.geometry_geojson), "properties": {"id": parcel.id, "khasra": parcel.khasra_number, "owner": parcel.owner, "area": parcel.area_hectares, "classification": parcel.classification, "status": parcel.status, "category": parcel.category, "village": parcel.village, "tehsil": parcel.tehsil, "district": parcel.district, "record_id": parcel.record_id}}


@app.get("/api/parcels")
def list_parcels(district: str | None = None, village: str | None = None, category: str | None = None, db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    statement = scope_parcels(select(Parcel).order_by(Parcel.khasra_number), user)
    if district:
        statement = statement.where(Parcel.district == district)
    if village:
        statement = statement.where(Parcel.village == village)
    if category:
        statement = statement.where(Parcel.category == category)
    return {"type": "FeatureCollection", "features": [parcel_feature(parcel) for parcel in db.scalars(statement)]}


@app.patch("/api/parcels/{parcel_id}")
def update_parcel(parcel_id: int, update: ParcelUpdate, db: Session = Depends(get_db), user: User = Depends(require_roles(*REVIEW_ROLES))):
    parcel = db.get(Parcel, parcel_id)
    if not parcel or (effective_state(user) and parcel.state != effective_state(user)):
        raise HTTPException(status_code=404, detail="Parcel not found")
    record_id_changed = "record_id" in update.model_dump(exclude_unset=True)
    for key, value in update.model_dump(exclude_unset=True).items():
        setattr(parcel, key, value)
    add_audit(db, "map", user.display_name, f"updated cadastral parcel {parcel.khasra_number}", parcel.record_id)
    # Linking (or relinking) a parcel to a record is exactly when the OCR-extracted Plot area
    # can newly be checked against this parcel's mapped geometry - re-run validation on the
    # linked document so that cross-modal check actually surfaces.
    if record_id_changed and parcel.record_id:
        linked_document = db.scalar(select(Document).options(selectinload(Document.fields)).where(Document.id == parcel.record_id))
        if linked_document and not (effective_state(user) and linked_document.state != effective_state(user)):
            linked_document.validation_issues = json.dumps(validate_record(db, linked_document))
    db.commit()
    db.refresh(parcel)
    return parcel_feature(parcel)


@app.get("/api/notifications", response_model=list[NotificationOut])
def notifications(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    items = list(db.scalars(select(Notification).where((Notification.user_id.is_(None)) | (Notification.user_id == user.id)).order_by(Notification.created_at.desc()).limit(30)))
    read_ids = set(db.scalars(select(NotificationReceipt.notification_id).where(NotificationReceipt.user_id == user.id)))
    return [{"id": item.id, "title": item.title, "message": item.message, "level": item.level, "read": item.id in read_ids, "created_at": item.created_at} for item in items]


@app.post("/api/notifications/{notification_id}/read", response_model=NotificationOut)
def mark_notification_read(notification_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    notification = db.get(Notification, notification_id)
    if not notification or notification.user_id not in (None, user.id):
        raise HTTPException(status_code=404, detail="Notification not found")
    receipt = db.scalar(select(NotificationReceipt).where(NotificationReceipt.notification_id == notification.id, NotificationReceipt.user_id == user.id))
    if not receipt:
        db.add(NotificationReceipt(notification_id=notification.id, user_id=user.id))
        db.commit()
    return {"id": notification.id, "title": notification.title, "message": notification.message, "level": notification.level, "read": True, "created_at": notification.created_at}


@app.get("/api/export/records.csv")
def export_records(db: Session = Depends(get_db), user: User = Depends(require_roles("Administrator", "Auditor"))):
    documents = list(db.scalars(scope_documents(select(Document).options(selectinload(Document.fields)).order_by(Document.created_at.desc()), user)).unique())
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Record ID", "Owner", "Ownership details", "Survey", "Khasra", "Khata", "Area", "Village", "Tehsil", "District", "Classification", "Mutation", "Registration", "Status", "Confidence", "Version"])
    for document in documents:
        writer.writerow([document.id, field_value(document, "Landowner name"), field_value(document, "Ownership details"), field_value(document, "Survey number"), field_value(document, "Khasra number"), field_value(document, "Khata number"), field_value(document, "Plot area"), field_value(document, "Village"), field_value(document, "Tehsil"), document.district, field_value(document, "Land classification"), field_value(document, "Mutation reference"), field_value(document, "Registration information"), document.status, document.confidence, document.version])
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=dhara-records.csv"})


@app.get("/api/export/audit.csv")
def export_audit(db: Session = Depends(get_db), user: User = Depends(require_roles("Administrator", "Auditor"))):
    statement = select(AuditEvent).order_by(AuditEvent.created_at.desc())
    if effective_state(user):
        in_state_ids = select(Document.id).where(Document.state == effective_state(user))
        statement = statement.where((AuditEvent.document_id.is_(None)) | (AuditEvent.document_id.in_(in_state_ids)))
    events = list(db.scalars(statement))
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Time", "Type", "Actor", "Record ID", "Action", "Details"])
    for event in events:
        writer.writerow([event.created_at.isoformat(), event.event_type, event.actor, event.document_id or "", event.action, event.details])
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=dhara-audit.csv"})


@app.get("/api/export/corrections.jsonl")
def export_corrections(db: Session = Depends(get_db), user: User = Depends(require_roles("Administrator"))):
    statement = select(FieldCorrection).order_by(FieldCorrection.created_at)
    if effective_state(user):
        statement = statement.where(FieldCorrection.document_id.in_(select(Document.id).where(Document.state == effective_state(user))))
    corrections = db.scalars(statement)
    lines = [json.dumps({
        "record_id": correction.document_id,
        "field": correction.field_label,
        "predicted": correction.predicted_value,
        "corrected": correction.corrected_value,
        "source_excerpt": correction.source_excerpt,
        "language": correction.language,
        "verified_by": correction.actor,
        "created_at": correction.created_at.isoformat(),
    }, ensure_ascii=False) for correction in corrections]
    payload = "\n".join(lines) + ("\n" if lines else "")
    return StreamingResponse(iter([payload]), media_type="application/x-ndjson", headers={"Content-Disposition": "attachment; filename=dhara-corrections.jsonl"})


@app.get("/api/export/parcels.geojson")
def export_parcels(db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    return JSONResponse({"type": "FeatureCollection", "features": [parcel_feature(parcel) for parcel in db.scalars(scope_parcels(select(Parcel), user))]}, headers={"Content-Disposition": "attachment; filename=dhara-parcels.geojson"})


@app.get("/api/registry-flags", response_model=list[RegistryFlagOut])
def list_registry_flags(status: str | None = None, db: Session = Depends(get_db), user: User = Depends(require_roles(*READ_ROLES))):
    statement = scope_registry_flags(select(RegistryFlag).order_by(RegistryFlag.created_at.desc()), user)
    if status:
        statement = statement.where(RegistryFlag.status == status)
    return list(db.scalars(statement))


@app.post("/api/registry-flags", response_model=RegistryFlagOut, status_code=201)
def create_registry_flag(payload: RegistryFlagIn, db: Session = Depends(get_db), user: User = Depends(require_roles(*REVIEW_ROLES))):
    state = effective_state(user) or (payload.state.strip() if payload.state else None)
    if not state:
        raise HTTPException(status_code=422, detail="A national user must specify which state this flag applies to")
    if effective_state(user) and payload.state and payload.state.strip() != effective_state(user):
        raise HTTPException(status_code=403, detail="You can only flag records within your own state")
    flag = RegistryFlag(
        state=state, district=payload.district.strip(), khasra_number=payload.khasra_number.strip(),
        flag_type=payload.flag_type.strip() or "Dispute", reference=payload.reference.strip(), notes=payload.notes.strip(),
        created_by=user.display_name,
    )
    db.add(flag)
    db.flush()
    add_audit(db, "flag", user.display_name, f"recorded a registry {flag.flag_type.lower()} on khasra {flag.khasra_number} in {flag.district}", None, flag.reference)
    # An active flag just created for a khasra may already match an existing document -
    # re-run validation on any in-state document with that khasra so the block surfaces
    # immediately instead of waiting for the next edit/approve attempt on that record.
    candidates = db.scalars(
        select(Document).options(selectinload(Document.fields)).where(Document.state == state, Document.district == flag.district)
    ).unique()
    for candidate in candidates:
        candidate.validation_issues = json.dumps(validate_record(db, candidate))
    db.commit()
    db.refresh(flag)
    return flag


@app.patch("/api/registry-flags/{flag_id}", response_model=RegistryFlagOut)
def update_registry_flag(flag_id: int, payload: RegistryFlagUpdate, db: Session = Depends(get_db), user: User = Depends(require_roles(*REVIEW_ROLES))):
    flag = db.get(RegistryFlag, flag_id)
    if not flag or (effective_state(user) and flag.state != effective_state(user)):
        raise HTTPException(status_code=404, detail="Registry flag not found")
    flag.status = payload.status.strip()
    add_audit(db, "flag", user.display_name, f"marked registry flag on khasra {flag.khasra_number} as {flag.status}", None, flag.reference)
    if flag.status != "Active":
        # Resolving a flag can un-block approval on any document it was blocking - re-run
        # validation on this state/district's documents so that clears immediately.
        candidates = db.scalars(
            select(Document).options(selectinload(Document.fields)).where(Document.state == flag.state, Document.district == flag.district)
        ).unique()
        for candidate in candidates:
            candidate.validation_issues = json.dumps(validate_record(db, candidate))
    db.commit()
    db.refresh(flag)
    return flag


DIST_DIR = PROJECT_ROOT / "dist"
if DIST_DIR.exists():
    assets_dir = DIST_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_spa(full_path: str):
        requested = (DIST_DIR / full_path).resolve()
        if full_path and requested.parent == DIST_DIR.resolve() and requested.is_file():
            return FileResponse(requested)
        return FileResponse(DIST_DIR / "index.html")
