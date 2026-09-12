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
