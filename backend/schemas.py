from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class FieldOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    label: str
    value: str
    original: str
    confidence: float
    valid: bool
    verified: bool


class FieldUpdate(BaseModel):
    value: str = Field(max_length=500)
    actor: str = Field(default="Priya Sharma", max_length=100)


class ExtractionField(BaseModel):
    id: int | None = None
    label: str = Field(max_length=100)
    value: str = Field(default="", max_length=500)
    original: str = Field(default="Not detected", max_length=500)
    confidence: float = Field(default=0, ge=0, le=100)
    valid: bool = False
    verified: bool = False


class PlotRowIn(BaseModel):
    khata: str = Field(default="", max_length=80)
    khasra: str = Field(default="", max_length=80)
    area: str = Field(default="", max_length=160)
    rent: str = Field(default="", max_length=40)
    cess: str = Field(default="", max_length=40)


class PlotRowOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    khata: str
    khasra: str
    area: str
    rent: str
    cess: str


class ExtractionSubmission(BaseModel):
    text: str = Field(min_length=1, max_length=1_000_000)
    engine: str = Field(default="Browser OCR", max_length=120)
    language: str = Field(default="Unknown", max_length=60)
    confidence: float = Field(default=0, ge=0, le=100)
    fields: list[ExtractionField] = Field(default_factory=list, max_length=20)
    pages: int = Field(default=1, ge=1, le=10_000)
    warnings: list[str] = Field(default_factory=list, max_length=10)
    plot_rows: list[PlotRowIn] = Field(default_factory=list, max_length=200)


class ExtractionFailure(BaseModel):
    message: str = Field(default="OCR could not recognize this source.", max_length=500)


class DocumentOut(BaseModel):
    id: str
    owner: str
    document: str
    filename: str
    location: str
    district: str
    survey: str
    type: str
    language: str
    confidence: float
    status: str
    updated: str
    created_at: datetime
    file_url: str | None
    ocr_engine: str
    fields: list[FieldOut] = Field(default_factory=list)
    plot_rows: list[PlotRowOut] = Field(default_factory=list)
    validation_issues: list[dict] = Field(default_factory=list)
    version: int = 1


class ApprovalRequest(BaseModel):
    actor: str = Field(default="Priya Sharma", max_length=100)


class AuditOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_type: str
    actor: str
    action: str
    document_id: str | None
    details: str
    event_hash: str
    created_at: datetime


class StatsOut(BaseModel):
    total_records: int
    needs_review: int
    verified: int
    processing: int
    average_confidence: float
    district_progress: list[dict] = Field(default_factory=list)
    daily_volume: list[dict] = Field(default_factory=list)


class LoginRequest(BaseModel):
    username: str = Field(max_length=120)
    password: str = Field(max_length=200)


class UserOut(BaseModel):
    username: str
    display_name: str
    role: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class AdminUserOut(UserOut):
    id: int
    active: bool
    created_at: datetime


class UserCreate(BaseModel):
    username: str = Field(max_length=120)
    display_name: str = Field(max_length=120)
    password: str = Field(min_length=10, max_length=200)
    role: str = Field(max_length=50)


class UserUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=120)
    role: str | None = Field(default=None, max_length=50)
    active: bool | None = None


class ParcelUpdate(BaseModel):
    owner: str | None = Field(default=None, max_length=200)
    classification: str | None = Field(default=None, max_length=120)
    status: str | None = Field(default=None, max_length=30)
    record_id: str | None = Field(default=None, max_length=32)


class NotificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    message: str
    level: str
    read: bool
    created_at: datetime
