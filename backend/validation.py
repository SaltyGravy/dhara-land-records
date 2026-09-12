import re

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .models import Document


REQUIRED_FIELDS = {"Landowner name", "Khasra number", "Village", "District"}


def _field_map(document: Document) -> dict[str, str]:
    return {field.label: field.value.strip() for field in document.fields}


def validate_record(db: Session, document: Document) -> list[dict]:
    values = _field_map(document)
    issues: list[dict] = []
    for label in REQUIRED_FIELDS:
        if not values.get(label):
            issues.append({"code": "required_field", "field": label, "severity": "error", "message": f"{label} is required before approval."})

    area = values.get("Plot area", "")
    if area:
        match = re.search(r"\d+(?:\.\d+)?", area)
        if not match or float(match.group()) <= 0:
            issues.append({"code": "invalid_area", "field": "Plot area", "severity": "error", "message": "Plot area must be a positive measurement."})

    khasra = values.get("Khasra number", "").casefold()
    owner = re.sub(r"\s+", " ", values.get("Landowner name", "").casefold())
    if khasra and owner:
        candidates = db.scalars(
            select(Document).options(selectinload(Document.fields)).where(Document.id != document.id, Document.district == document.district)
        ).unique()
        for candidate in candidates:
            candidate_values = _field_map(candidate)
            if candidate_values.get("Khasra number", "").casefold() == khasra and re.sub(r"\s+", " ", candidate_values.get("Landowner name", "").casefold()) == owner:
                issues.append({"code": "possible_duplicate", "field": "Khasra number", "severity": "warning", "message": f"Possible duplicate of record {candidate.id}."})
                break
    return issues

