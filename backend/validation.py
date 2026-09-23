import json
import math
import re

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .models import Document, Parcel
from .textmatch import similar


REQUIRED_FIELDS = {"Landowner name", "Khasra number", "Village", "District"}

# How much two strings are allowed to differ (as a fraction of the longer string's length,
# via Levenshtein edit distance) and still be treated as "the same, modulo OCR noise". Khasra
# numbers are short identifiers, so a single mistaken digit is already a meaningful fraction
# of the string; owner names tolerate a bit more since OCR commonly drops or fuses a character
# in a multi-word name without changing who the name refers to.
KHASRA_SIMILARITY_RATIO = 0.25
NAME_SIMILARITY_RATIO = 0.3

# How far an OCR-extracted "Plot area" value is allowed to drift from the area computed from
# the linked parcel's own mapped geometry before it is worth a human look. Generous on purpose:
# this is an equirectangular-projection approximation (see _geometry_area_hectares), not a
# survey-grade figure, and hand-entered demo/seed geometry is not guaranteed to be to scale.
AREA_MISMATCH_TOLERANCE = 0.25

_INDIC_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")

_AREA_UNIT_TO_HECTARES = {
    "hectare": 1.0, "hectares": 1.0, "ha": 1.0,
    "हे": 1.0, "हे०": 1.0, "हेक्टेयर": 1.0,
    "acre": 0.404686, "acres": 0.404686, "एकड़": 0.404686,
    "sqm": 0.0001,
}

_EARTH_METERS_PER_DEGREE = 111_320.0


def _field_map(document: Document) -> dict[str, str]:
    return {field.label: field.value.strip() for field in document.fields}


def _parse_area_hectares(text: str) -> float | None:
    if not text:
        return None
    normalized = text.translate(_INDIC_DIGITS).strip().lower()
    match = re.search(r"(\d+(?:\.\d+)?)\s*(hectares?|ha|acres?|sq\.?\s*m\.?|हे(?:क्टेयर)?०?|एकड़)?", normalized)
    if not match:
        return None
    try:
        number = float(match.group(1))
    except ValueError:
        return None
    unit = (match.group(2) or "").replace(" ", "").replace(".", "")
    if not unit:
        # FIELD_RULES/extractStructuredFields capture a bare number when the source omits a
        # unit; hectares is the register convention these forms otherwise use.
        return number
    factor = _AREA_UNIT_TO_HECTARES.get(unit) or _AREA_UNIT_TO_HECTARES.get(unit.rstrip("s"))
    return number * factor if factor is not None else None


def _ring_area_hectares(ring: list[list[float]]) -> float:
    if len(ring) < 3:
        return 0.0
    # Equirectangular projection around the ring's mean latitude, then the shoelace formula.
    # Fine at cadastral-parcel scale (tens to hundreds of metres); not survey-grade geodesy.
    mean_lat_rad = math.radians(sum(point[1] for point in ring) / len(ring))
    meters_per_deg_lon = _EARTH_METERS_PER_DEGREE * math.cos(mean_lat_rad)
    projected = [(lon * meters_per_deg_lon, lat * _EARTH_METERS_PER_DEGREE) for lon, lat in ring]
    area_m2 = 0.0
    for index in range(len(projected)):
        x1, y1 = projected[index]
        x2, y2 = projected[(index + 1) % len(projected)]
        area_m2 += x1 * y2 - x2 * y1
    return abs(area_m2) / 2 / 10_000


def _geometry_area_hectares(geometry: dict) -> float | None:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if not coordinates:
        return None
    if geometry_type == "Polygon":
        rings = [coordinates[0]] if coordinates[0] else []
    elif geometry_type == "MultiPolygon":
        rings = [polygon[0] for polygon in coordinates if polygon and polygon[0]]
    else:
        return None
    total = sum(_ring_area_hectares(ring) for ring in rings)
    return total if total > 0 else None


def _duplicate_and_conflict_checks(db: Session, document: Document, values: dict[str, str], issues: list[dict]) -> None:
    khasra = re.sub(r"\s+", "", values.get("Khasra number", "").casefold())
    owner = re.sub(r"\s+", " ", values.get("Landowner name", "").casefold()).strip()
    if not khasra:
        return
    candidates = db.scalars(
        select(Document).options(selectinload(Document.fields)).where(Document.id != document.id, Document.district == document.district)
    ).unique()
    duplicate_of: str | None = None
    for candidate in candidates:
        candidate_values = _field_map(candidate)
        candidate_khasra = re.sub(r"\s+", "", candidate_values.get("Khasra number", "").casefold())
        candidate_owner = re.sub(r"\s+", " ", candidate_values.get("Landowner name", "").casefold()).strip()
        if not similar(khasra, candidate_khasra, KHASRA_SIMILARITY_RATIO):
            continue
        if not owner or not candidate_owner:
            continue
        if similar(owner, candidate_owner, NAME_SIMILARITY_RATIO):
            duplicate_of = duplicate_of or candidate.id
            continue
        # Same plot, two different recorded owners - the actual land-dispute signal, distinct
        # from an OCR-variant duplicate of the same entry.
        issues.append({
            "code": "ownership_conflict", "field": "Khasra number", "severity": "error",
            "message": f"Khasra {values.get('Khasra number', '')} is also recorded under a different owner "
                       f"in record {candidate.id} ({candidate_values.get('Landowner name', '')}) - possible ownership dispute.",
        })
    if duplicate_of and not any(issue["code"] == "ownership_conflict" for issue in issues):
        issues.append({"code": "possible_duplicate", "field": "Khasra number", "severity": "warning", "message": f"Possible duplicate of record {duplicate_of}."})


def _plot_row_checks(document: Document, issues: list[dict]) -> None:
    if not document.plot_rows:
        return
    seen: dict[str, int] = {}
    for row in document.plot_rows:
        if row.area:
            parsed = _parse_area_hectares(row.area)
            if parsed is None:
                issues.append({"code": "invalid_plot_row_area", "field": "Plot area", "severity": "warning", "message": f"Plot row for khasra {row.khasra or '(blank)'} has an area that could not be parsed: '{row.area}'."})
            elif parsed <= 0:
                issues.append({"code": "invalid_plot_row_area", "field": "Plot area", "severity": "error", "message": f"Plot row for khasra {row.khasra or '(blank)'} has a non-positive area."})
        key = row.khasra.strip().casefold()
        if key:
            seen[key] = seen.get(key, 0) + 1
    for khasra, count in seen.items():
        if count > 1:
            issues.append({"code": "intra_batch_duplicate_khasra", "field": "Khasra number", "severity": "warning", "message": f"Khasra {khasra} appears {count} times in this register's plot table."})


def _cross_modal_area_check(db: Session, document: Document, values: dict[str, str], issues: list[dict]) -> None:
    plot_area = _parse_area_hectares(values.get("Plot area", ""))
    if not plot_area or plot_area <= 0:
        return
    khasra = values.get("Khasra number", "").strip()
    parcel = db.scalar(select(Parcel).where(Parcel.record_id == document.id))
    if not parcel and khasra:
        parcel = db.scalar(select(Parcel).where(Parcel.district == document.district, Parcel.khasra_number == khasra))
    if not parcel:
        return
    try:
        geometry = json.loads(parcel.geometry_geojson)
    except (json.JSONDecodeError, TypeError):
        return
    geometry_area = _geometry_area_hectares(geometry)
    if not geometry_area or geometry_area <= 0:
        return
    larger, smaller = max(plot_area, geometry_area), min(plot_area, geometry_area)
    if (larger - smaller) / larger > AREA_MISMATCH_TOLERANCE:
        issues.append({
            "code": "area_geometry_mismatch", "field": "Plot area", "severity": "warning",
            "message": f"Extracted plot area ({plot_area:.2f} ha) disagrees with the linked parcel's mapped geometry "
                       f"({geometry_area:.2f} ha) by more than {int(AREA_MISMATCH_TOLERANCE * 100)}%.",
        })


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

    _duplicate_and_conflict_checks(db, document, values, issues)
    _plot_row_checks(document, issues)
    _cross_modal_area_check(db, document, values, issues)
    return issues
