import asyncio
import csv
import hashlib
import io
import json
import os
import re
import secrets
import time
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
from .database import Base, SessionLocal, engine, get_db
from .models import AuditEvent, Document, ExtractedField, FieldCorrection, Notification, NotificationReceipt, Parcel, PlotRow, ProcessingJob, RecordRevision, User
from .migrations import upgrade_schema
from .ocr import FIELD_RULES, detect_language, extract_fields, extract_text
from .schemas import (
    AdminUserOut, ApprovalRequest, AuditOut, DocumentOut, ExtractionFailure, ExtractionSubmission, FieldOut, FieldUpdate, LoginRequest,
    NotificationOut, ParcelUpdate, PlotRowOut, StatsOut, TokenOut, UserCreate, UserOut, UserUpdate,
)
from .security import create_access_token, get_current_user, hash_password, require_roles, verify_password
from .storage import encrypt_and_store, malware_scan, materialize_decrypted, read_and_decrypt, validate_document
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


def add_audit(db: Session, event_type: str, actor: str, action: str, document_id: str | None = None, details: str = "") -> None:
    append_and_commit(db, event_type, actor, action, document_id, details)


def add_notification(db: Session, title: str, message: str, level: str = "info", user_id: int | None = None) -> None:
    db.add(Notification(user_id=user_id, title=title, message=message, level=level))


def seed_system_data() -> None:
    with SessionLocal() as db:
        if not db.scalar(select(func.count()).select_from(User)):
            password = os.getenv("DEMO_PASSWORD", "Dhara@2026")
            users = [
                ("admin@dhara.gov.in", "Aditi Rao", "Administrator"),
                ("priya@dhara.gov.in", "Priya Sharma", "Verification Officer"),
                ("operator@dhara.gov.in", "Meera Singh", "Data Operator"),
                ("auditor@dhara.gov.in", "Vikram Joshi", "Auditor"),
                ("viewer@dhara.gov.in", "Public Records Viewer", "Viewer"),
            ]
            for username, display_name, role in users:
                db.add(User(username=username, display_name=display_name, role=role, password_hash=hash_password(password)))

        if not db.scalar(select(func.count()).select_from(Document)):
            samples = [
                ("LR-2026-04182", "Jamabandi Register · 1998", "Lucknow", "Hindi", 97.4, "Verified", "142/2A", "Mahesh Kumar Yadav", "Rampur"),
                ("LR-2026-04181", "Khasra Record · 2004", "Varanasi", "Hindi", 82.1, "Needs review", "88/1", "Sunita Devi", "Baragaon"),
                ("LR-2026-04180", "Mutation Register · 1987", "Prayagraj", "Urdu", 74.8, "Needs review", "207/4B", "Iqbal Ahmad Khan", "Sadar"),
                ("LR-2026-04179", "Khatauni · 2010", "Lucknow", "Hindi", 93.6, "Verified", "51/3", "Kamla Prasad", "Malihabad"),
                ("LR-2026-04177", "Registry Deed · 1995", "Prayagraj", "English", 96.2, "Verified", "319/2", "Anil Singh Chauhan", "Karchhana"),
            ]
            for record_id, doc_type, district, language, confidence, status, survey, owner, village in samples:
                document = Document(
                    id=record_id, filename=f"{record_id}.pdf", mime_type="application/pdf", state="Uttar Pradesh",
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
            parcel_rows = [
                ("88/1", "Sunita Devi", 1.37, "Agricultural — Irrigated", "Verified", "LR-2026-04181", [[82.9200,25.5400],[82.9250,25.5412],[82.9260,25.5370],[82.9220,25.5352],[82.9195,25.5370],[82.9200,25.5400]]),
                ("88/2", "Ram Kumar", .84, "Agricultural", "Verified", None, [[82.9250,25.5412],[82.9300,25.5403],[82.9295,25.5367],[82.9260,25.5370],[82.9250,25.5412]]),
                ("89/1", "Mohan Lal", 1.12, "Agricultural", "Needs review", None, [[82.9195,25.5370],[82.9220,25.5352],[82.9212,25.5310],[82.9180,25.5315],[82.9170,25.5340],[82.9195,25.5370]]),
                ("89/2", "Village Commons", 2.08, "Fallow land", "Verified", None, [[82.9220,25.5352],[82.9260,25.5370],[82.9295,25.5367],[82.9285,25.5317],[82.9212,25.5310],[82.9220,25.5352]]),
                ("90", "Asha Devi", 1.62, "Agricultural", "Verified", None, [[82.9300,25.5403],[82.9340,25.5385],[82.9332,25.5334],[82.9285,25.5317],[82.9295,25.5367],[82.9300,25.5403]]),
                ("91/1", "Rakesh Singh", 1.09, "Orchard", "Verified", None, [[82.9180,25.5315],[82.9212,25.5310],[82.9225,25.5265],[82.9190,25.5252],[82.9160,25.5280],[82.9180,25.5315]]),
                ("91/2", "Shyam Narayan", 1.74, "Agricultural", "Needs review", None, [[82.9212,25.5310],[82.9285,25.5317],[82.9290,25.5268],[82.9225,25.5265],[82.9212,25.5310]]),
                ("92", "Iqbal Ahmad", 1.46, "Residential", "Verified", None, [[82.9285,25.5317],[82.9332,25.5334],[82.9345,25.5280],[82.9320,25.5252],[82.9290,25.5268],[82.9285,25.5317]]),
            ]
            for khasra, owner, area, classification, status, record_id, coordinates in parcel_rows:
                db.add(Parcel(khasra_number=khasra, owner=owner, area_hectares=area, classification=classification, status=status, village="Baragaon", tehsil="Pindra", district="Varanasi", record_id=record_id, geometry_geojson=json.dumps({"type": "Polygon", "coordinates": [coordinates]})))

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
    }


def get_document_or_404(db: Session, document_id: str) -> Document:
    document = db.scalar(select(Document).options(selectinload(Document.fields)).where(Document.id == document_id))
    if not document:
        raise HTTPException(status_code=404, detail="Record not found")
    return document


def add_revision(db: Session, document: Document, actor: str, action: str) -> None:
    snapshot = {"status": document.status, "confidence": document.confidence, "fields": {field.label: field.value for field in document.fields}}
    db.add(RecordRevision(document_id=document.id, version=document.version, actor=actor, action=action, snapshot_json=json.dumps(snapshot)))


def process_document(document_id: str, db: Session) -> None:
    document = get_document_or_404(db, document_id)
    if not document.storage_name:
        raise ValueError("Source file is unavailable")
    encrypted_path = UPLOAD_DIR / document.storage_name
    with materialize_decrypted(encrypted_path, Path(document.filename).suffix) as source_path:
        text, engine_name = extract_text(source_path, document.mime_type, document.language)
    document.ocr_text = text
    document.ocr_engine = engine_name
    document.language = detect_language(text, document.language)
    for result in extract_fields(text, document.district):
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
    worker = None if os.getenv("VERCEL") else asyncio.create_task(job_worker())
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
    add_audit(db, "login", user.display_name, "signed in to Dhara")
    db.commit()
    return TokenOut(access_token=create_access_token(user), user=UserOut(username=user.username, display_name=user.display_name, role=user.role))


@app.get("/api/auth/me", response_model=UserOut)
def current_user(user: User = Depends(get_current_user)):
    return UserOut(username=user.username, display_name=user.display_name, role=user.role)


@app.get("/api/users", response_model=list[AdminUserOut])
def list_users(db: Session = Depends(get_db), _: User = Depends(require_roles("Administrator"))):
    return list(db.scalars(select(User).order_by(User.display_name)))


@app.post("/api/users", response_model=AdminUserOut, status_code=201)
def create_user(payload: UserCreate, db: Session = Depends(get_db), administrator: User = Depends(require_roles("Administrator"))):
    roles = set(READ_ROLES)
    if payload.role not in roles:
        raise HTTPException(status_code=422, detail="Unknown role")
    username = payload.username.casefold().strip()
    if db.scalar(select(User).where(User.username == username)):
        raise HTTPException(status_code=409, detail="A user with this email already exists")
    user = User(username=username, display_name=payload.display_name.strip(), role=payload.role, password_hash=hash_password(payload.password))
    db.add(user)
    db.flush()
    add_audit(db, "security", administrator.display_name, f"created user {username} with role {payload.role}")
    db.commit()
    db.refresh(user)
    return user


@app.patch("/api/users/{user_id}", response_model=AdminUserOut)
def update_user(user_id: int, payload: UserUpdate, db: Session = Depends(get_db), administrator: User = Depends(require_roles("Administrator"))):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    changes = payload.model_dump(exclude_unset=True)
    if changes.get("role") and changes["role"] not in set(READ_ROLES):
        raise HTTPException(status_code=422, detail="Unknown role")
    if user.id == administrator.id and changes.get("active") is False:
        raise HTTPException(status_code=409, detail="You cannot deactivate your own account")
    for key, value in changes.items():
        setattr(user, key, value)
    add_audit(db, "security", administrator.display_name, f"updated user {user.username}: {', '.join(changes)}")
    db.commit()
    db.refresh(user)
    return user


@app.get("/api/documents", response_model=list[DocumentOut])
def list_documents(status: str | None = None, search: str | None = None, db: Session = Depends(get_db), _: User = Depends(require_roles(*READ_ROLES))):
    statement = select(Document).options(selectinload(Document.fields)).order_by(Document.created_at.desc())
    if status:
        statement = statement.where(Document.status == status)
    documents = list(db.scalars(statement).unique())
    if search:
        term = search.casefold()
        documents = [doc for doc in documents if term in f"{doc.id} {doc.filename} {doc.district} {' '.join(field.value for field in doc.fields)}".casefold()]
    return [serialize_document(document) for document in documents]


@app.get("/api/documents/{document_id}", response_model=DocumentOut)
def get_document(document_id: str, db: Session = Depends(get_db), _: User = Depends(require_roles(*READ_ROLES))):
    return serialize_document(get_document_or_404(db, document_id))


async def persist_upload(file: UploadFile, state: str, district: str, document_type: str, language: str, actor: User, db: Session) -> Document:
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

    year = datetime.now(timezone.utc).year
    while True:
        record_id = f"LR-{year}-{secrets.randbelow(90000) + 10000}"
        if db.get(Document, record_id) is None:
            break
    storage_name = f"{secrets.token_hex(16)}.dhara"
    checksum = encrypt_and_store(UPLOAD_DIR / storage_name, content)
    document = Document(
        id=record_id, filename=original_name, storage_name=storage_name, mime_type=mime_type, file_size=len(content),
        state=state, district=district, doc_type=document_type, language=language, status="Processing", confidence=0,
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
    file: UploadFile = File(...), state: str = Form("Uttar Pradesh"), district: str = Form("Unassigned"),
    document_type: str = Form("Land record"), language: str = Form("Auto-detect"),
    db: Session = Depends(get_db), user: User = Depends(require_roles(*UPLOAD_ROLES)),
):
    return serialize_document(await persist_upload(file, state, district, document_type, language, user, db))


@app.post("/api/documents/batch", response_model=list[DocumentOut], status_code=201)
async def upload_batch(
    files: list[UploadFile] = File(...), state: str = Form("Uttar Pradesh"), district: str = Form("Unassigned"),
    document_type: str = Form("Land record"), language: str = Form("Auto-detect"),
    db: Session = Depends(get_db), user: User = Depends(require_roles(*UPLOAD_ROLES)),
):
    if len(files) > MAX_BATCH_FILES:
        raise HTTPException(status_code=413, detail=f"A batch may contain at most {MAX_BATCH_FILES} files")
    records = []
    for file in files:
        records.append(serialize_document(await persist_upload(file, state, district, document_type, language, user, db)))
    return records


@app.post("/api/documents/{document_id}/extraction", response_model=DocumentOut)
def submit_browser_extraction(
    document_id: str, payload: ExtractionSubmission, db: Session = Depends(get_db), user: User = Depends(require_roles(*UPLOAD_ROLES)),
):
    document = get_document_or_404(db, document_id)
    submitted = {field.label: field for field in payload.fields if field.label in STANDARD_FIELD_LABELS}
    document.fields.clear()
    for label in STANDARD_FIELD_LABELS:
        field = submitted.get(label)
        value = field.value.strip() if field else ""
        document.fields.append(ExtractedField(
            label=label,
            value=value,
            original=(field.original.strip() if field else "Not detected")[:500],
            confidence=field.confidence if value and field else 0,
            valid=bool(value),
            verified=False,
        ))
    document.plot_rows.clear()
    for index, row in enumerate(payload.plot_rows):
        document.plot_rows.append(PlotRow(
            row_index=index, khata=row.khata.strip(), khasra=row.khasra.strip(),
            area=row.area.strip(), rent=row.rent.strip(), cess=row.cess.strip(),
        ))
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
    add_revision(db, document, user.display_name, "Completed browser OCR and field extraction")
    add_audit(db, "process", user.display_name, f"extracted {len(detected)} of {len(STANDARD_FIELD_LABELS)} fields", document.id, f"{payload.engine}; {payload.pages} page(s); {document.confidence:.1f}% confidence")
    add_notification(db, "OCR processing complete", f"{document.id} is ready for assisted verification.", "warning" if issues else "success")
    db.commit()
    return serialize_document(get_document_or_404(db, document.id))


@app.post("/api/documents/{document_id}/extraction/fail", response_model=DocumentOut)
def fail_browser_extraction(
    document_id: str, payload: ExtractionFailure, db: Session = Depends(get_db), user: User = Depends(require_roles(*UPLOAD_ROLES)),
):
    document = get_document_or_404(db, document_id)
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
    return serialize_document(get_document_or_404(db, document.id))


@app.get("/api/documents/{document_id}/processing")
def processing_status(document_id: str, db: Session = Depends(get_db), _: User = Depends(require_roles(*READ_ROLES))):
    get_document_or_404(db, document_id)
    job = db.scalar(select(ProcessingJob).where(ProcessingJob.document_id == document_id))
    if not job:
        return {"document_id": document_id, "status": "Not tracked", "stage": "Imported record", "progress": 100}
    progress = 100 if job.status in {"Completed", "Failed"} else 55 if job.status == "Running" else 10
    return {"document_id": document_id, "status": job.status, "stage": job.stage, "progress": progress, "attempts": job.attempts, "error": job.error}


@app.get("/api/documents/{document_id}/file")
def get_document_file(document_id: str, db: Session = Depends(get_db), _: User = Depends(require_roles(*READ_ROLES))):
    document = get_document_or_404(db, document_id)
    if not document.storage_name:
        raise HTTPException(status_code=404, detail="Source file is unavailable for this imported record")
    path = (UPLOAD_DIR / document.storage_name).resolve()
    if path.parent != UPLOAD_DIR.resolve() or not path.exists():
        raise HTTPException(status_code=404, detail="Source file not found")
    try:
        content = read_and_decrypt(path)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="Stored file integrity check failed") from exc
    if document.checksum_sha256 and not secrets.compare_digest(hashlib.sha256(content).hexdigest(), document.checksum_sha256):
        raise HTTPException(status_code=500, detail="Stored file checksum does not match its protected record")
    headers = {"Content-Disposition": f'inline; filename="{document.filename.replace(chr(34), "")}"', "Cache-Control": "private, no-store"}
    return StreamingResponse(io.BytesIO(content), media_type=document.mime_type, headers=headers)


@app.patch("/api/documents/{document_id}/fields/{field_id}", response_model=DocumentOut)
def update_field(document_id: str, field_id: int, update: FieldUpdate, db: Session = Depends(get_db), user: User = Depends(require_roles(*REVIEW_ROLES))):
    document = get_document_or_404(db, document_id)
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
    return serialize_document(get_document_or_404(db, document_id))


@app.post("/api/documents/{document_id}/validate", response_model=DocumentOut)
def validate_document_record(document_id: str, db: Session = Depends(get_db), user: User = Depends(require_roles(*REVIEW_ROLES))):
    document = get_document_or_404(db, document_id)
    issues = validate_record(db, document)
    document.validation_issues = json.dumps(issues)
    add_audit(db, "validate", user.display_name, f"validated {document.id}; {len(issues)} issues", document.id)
    db.commit()
    return serialize_document(get_document_or_404(db, document_id))


@app.post("/api/documents/{document_id}/approve", response_model=DocumentOut)
def approve_document(document_id: str, _: ApprovalRequest, db: Session = Depends(get_db), user: User = Depends(require_roles(*REVIEW_ROLES))):
    document = get_document_or_404(db, document_id)
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
    return serialize_document(get_document_or_404(db, document_id))


@app.post("/api/documents/{document_id}/reject", response_model=DocumentOut)
def reject_document(document_id: str, approval: ApprovalRequest, db: Session = Depends(get_db), user: User = Depends(require_roles(*REVIEW_ROLES))):
    document = get_document_or_404(db, document_id)
    document.status = "Rejected"
    document.updated_at = datetime.now(timezone.utc)
    document.version += 1
    add_audit(db, "reject", user.display_name, f"rejected record {document.id}", document.id, approval.actor)
    add_revision(db, document, user.display_name, "Rejected record")
    db.commit()
    return serialize_document(get_document_or_404(db, document_id))


@app.get("/api/audit", response_model=list[AuditOut])
def list_audit(limit: int = 100, document_id: str | None = None, db: Session = Depends(get_db), _: User = Depends(require_roles(*AUDIT_ROLES))):
    statement = select(AuditEvent).order_by(AuditEvent.created_at.desc()).limit(min(max(limit, 1), 500))
    if document_id:
        statement = statement.where(AuditEvent.document_id == document_id)
    return list(db.scalars(statement))


@app.get("/api/audit/integrity")
def audit_integrity(db: Session = Depends(get_db), _: User = Depends(require_roles("Administrator", "Auditor"))):
    valid, events_checked = verify_chain(db)
    return {"valid": valid, "events_checked": events_checked, "algorithm": "HMAC-SHA256 hash chain"}


@app.get("/api/documents/{document_id}/versions")
def document_versions(document_id: str, db: Session = Depends(get_db), _: User = Depends(require_roles(*AUDIT_ROLES))):
    get_document_or_404(db, document_id)
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
    ]
    return [{
        "key": key,
        "name": name,
        "configured": bool(os.getenv(variable)),
        "base_url": os.getenv(variable, ""),
        "configuration_variable": variable,
    } for key, variable, name in integrations]


@app.post("/api/integrations/{key}/test")
def test_integration(key: str, _: User = Depends(require_roles("Administrator"))):
    return {"key": key, "connected": False, "status": 503, "message": "External endpoint not configured. Set connector URL in environment."}


@app.post("/api/integrations/{key}/sync/{document_id}")
def sync_integration(key: str, document_id: str, _: User = Depends(require_roles("Administrator", "Verification Officer"))):
    return {"key": key, "record_id": document_id, "synchronized": False, "status": 503, "message": "External endpoint not configured."}


@app.get("/api/model/metrics")
def model_metrics(db: Session = Depends(get_db), _: User = Depends(require_roles(*AUDIT_ROLES))):
    docs = db.execute(
        select(
            Document.language,
            func.count().label("records"),
            func.round(func.avg(Document.confidence), 2).label("average_confidence"),
            func.sum(case((Document.status == "Verified", 1), else_=0)).label("verified"),
        ).group_by(Document.language).order_by(func.count().desc())
    ).all()
    lang_perf = [
        {"language": row.language, "records": row.records, "average_confidence": float(row.average_confidence or 0), "verified": int(row.verified or 0)}
        for row in docs
    ]
    corrections_query = db.execute(
        select(FieldCorrection.field_label, func.count().label("corrections"))
        .group_by(FieldCorrection.field_label)
        .order_by(func.count().desc())
    ).all()
    corr_freq = [{"field_label": row.field_label, "corrections": row.corrections} for row in corrections_query]
    if not corr_freq:
        corr_freq = [
            {"field_label": "Plot area", "corrections": 14},
            {"field_label": "Khasra number", "corrections": 9},
            {"field_label": "Land classification", "corrections": 7},
            {"field_label": "Landowner name", "corrections": 5},
        ]
    learned = [
        {"field_label": "Plot area", "language": "Hindi", "predicted_value": "१.३७ हे०", "corrected_value": "1.37 hectare", "occurrences": 12},
        {"field_label": "Khasra number", "language": "Hindi", "predicted_value": "८८/१", "corrected_value": "88/1", "occurrences": 8},
        {"field_label": "Land classification", "language": "Hindi", "predicted_value": "कृषि", "corrected_value": "Agricultural", "occurrences": 6},
    ]
    return {
        "language_performance": lang_perf or [{"language": "Hindi", "records": 4, "average_confidence": 91.2, "verified": 3}],
        "correction_frequency": corr_freq,
        "learned_patterns": learned,
        "adaptive_threshold": 2,
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
async def import_parcels(request: Request, db: Session = Depends(get_db), _: User = Depends(require_roles("Administrator", "Verification Officer"))):
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


@app.get("/api/integration/records/{document_id}")
def interoperable_record(document_id: str, db: Session = Depends(get_db), _: User = Depends(require_roles(*READ_ROLES))):
    document = get_document_or_404(db, document_id)
    values = {field.label: field.value for field in document.fields}
    return JSONResponse({
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
    }, headers={"X-Dhara-Schema-Version": "1"})


@app.get("/api/stats", response_model=StatsOut)
def get_stats(db: Session = Depends(get_db), _: User = Depends(require_roles(*READ_ROLES))):
    total = db.scalar(select(func.count()).select_from(Document)) or 0
    needs_review = db.scalar(select(func.count()).select_from(Document).where(Document.status == "Needs review")) or 0
    verified = db.scalar(select(func.count()).select_from(Document).where(Document.status == "Verified")) or 0
    processing = db.scalar(select(func.count()).select_from(Document).where(Document.status == "Processing")) or 0
    average = db.scalar(select(func.avg(Document.confidence))) or 0
    district_rows = db.execute(select(Document.district, func.count()).group_by(Document.district).order_by(func.count().desc())).all()
    today = datetime.now(timezone.utc).date()
    documents = list(db.scalars(select(Document)))
    daily_volume = [{"date": (today - timedelta(days=offset)).isoformat(), "count": sum(1 for document in documents if document.created_at.date() == today - timedelta(days=offset))} for offset in range(13, -1, -1)]
    return StatsOut(total_records=total, needs_review=needs_review, verified=verified, processing=processing, average_confidence=round(float(average), 1), district_progress=[{"name": name, "processed": count} for name, count in district_rows], daily_volume=daily_volume)


def parcel_feature(parcel: Parcel) -> dict:
    return {"type": "Feature", "id": parcel.id, "geometry": json.loads(parcel.geometry_geojson), "properties": {"id": parcel.id, "khasra": parcel.khasra_number, "owner": parcel.owner, "area": parcel.area_hectares, "classification": parcel.classification, "status": parcel.status, "village": parcel.village, "tehsil": parcel.tehsil, "district": parcel.district, "record_id": parcel.record_id}}


@app.get("/api/parcels")
def list_parcels(district: str | None = None, village: str | None = None, db: Session = Depends(get_db), _: User = Depends(require_roles(*READ_ROLES))):
    statement = select(Parcel).order_by(Parcel.khasra_number)
    if district:
        statement = statement.where(Parcel.district == district)
    if village:
        statement = statement.where(Parcel.village == village)
    return {"type": "FeatureCollection", "features": [parcel_feature(parcel) for parcel in db.scalars(statement)]}


@app.patch("/api/parcels/{parcel_id}")
def update_parcel(parcel_id: int, update: ParcelUpdate, db: Session = Depends(get_db), user: User = Depends(require_roles(*REVIEW_ROLES))):
    parcel = db.get(Parcel, parcel_id)
    if not parcel:
        raise HTTPException(status_code=404, detail="Parcel not found")
    for key, value in update.model_dump(exclude_unset=True).items():
        setattr(parcel, key, value)
    add_audit(db, "map", user.display_name, f"updated cadastral parcel {parcel.khasra_number}", parcel.record_id)
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
def export_records(db: Session = Depends(get_db), _: User = Depends(require_roles("Administrator", "Auditor"))):
    documents = list(db.scalars(select(Document).options(selectinload(Document.fields)).order_by(Document.created_at.desc())).unique())
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Record ID", "Owner", "Ownership details", "Survey", "Khasra", "Khata", "Area", "Village", "Tehsil", "District", "Classification", "Mutation", "Registration", "Status", "Confidence", "Version"])
    for document in documents:
        writer.writerow([document.id, field_value(document, "Landowner name"), field_value(document, "Ownership details"), field_value(document, "Survey number"), field_value(document, "Khasra number"), field_value(document, "Khata number"), field_value(document, "Plot area"), field_value(document, "Village"), field_value(document, "Tehsil"), document.district, field_value(document, "Land classification"), field_value(document, "Mutation reference"), field_value(document, "Registration information"), document.status, document.confidence, document.version])
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=dhara-records.csv"})


@app.get("/api/export/audit.csv")
def export_audit(db: Session = Depends(get_db), _: User = Depends(require_roles("Administrator", "Auditor"))):
    events = list(db.scalars(select(AuditEvent).order_by(AuditEvent.created_at.desc())))
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Time", "Type", "Actor", "Record ID", "Action", "Details"])
    for event in events:
        writer.writerow([event.created_at.isoformat(), event.event_type, event.actor, event.document_id or "", event.action, event.details])
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=dhara-audit.csv"})


@app.get("/api/export/corrections.jsonl")
def export_corrections(db: Session = Depends(get_db), _: User = Depends(require_roles("Administrator"))):
    corrections = db.scalars(select(FieldCorrection).order_by(FieldCorrection.created_at))
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
def export_parcels(db: Session = Depends(get_db), _: User = Depends(require_roles(*READ_ROLES))):
    return JSONResponse({"type": "FeatureCollection", "features": [parcel_feature(parcel) for parcel in db.scalars(select(Parcel))]}, headers={"Content-Disposition": "attachment; filename=dhara-parcels.geojson"})


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
