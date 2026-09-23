import io
import os
import tempfile
import time
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image


TEMP_ROOT = Path(tempfile.mkdtemp(prefix="dhara-tests-"))
os.environ["DATABASE_URL"] = f"sqlite:///{TEMP_ROOT / 'test.db'}"
os.environ["UPLOAD_DIR"] = str(TEMP_ROOT / "uploads")
os.environ["DEMO_PASSWORD"] = "test-password"
os.environ["TOKEN_SECRET"] = "test-token-secret-with-sufficient-entropy"
os.environ["FILE_ENCRYPTION_KEY"] = "test-file-key-with-sufficient-entropy"

from backend.app import app


def auth(client: TestClient, username: str) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"username": username, "password": "test-password"})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def png_bytes() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (80, 50), "white").save(output, format="PNG")
    return output.getvalue()


def wait_for_processing(client: TestClient, record_id: str, headers: dict[str, str]) -> dict:
    for _ in range(40):
        response = client.get(f"/api/documents/{record_id}", headers=headers)
        assert response.status_code == 200
        if response.json()["status"] != "Processing":
            return response.json()
        time.sleep(.1)
    raise AssertionError("processing did not complete")


def test_authentication_and_role_enforcement():
    with TestClient(app) as client:
        assert client.get("/api/documents").status_code == 401
        viewer = auth(client, "viewer@dhara.gov.in")
        assert client.get("/api/documents", headers=viewer).status_code == 200
        denied = client.post(
            "/api/documents",
            files={"file": ("record.png", png_bytes(), "image/png")},
            headers=viewer,
        )
        assert denied.status_code == 403


def test_upload_encryption_correction_validation_approval_and_audit():
    with TestClient(app) as client:
        operator = auth(client, "operator@dhara.gov.in")
        reviewer = auth(client, "priya@dhara.gov.in")
        upload = client.post(
            "/api/documents",
            files={"file": ("record.png", png_bytes(), "image/png")},
            data={"state": "Uttar Pradesh", "district": "Varanasi", "document_type": "Khasra", "language": "Hindi"},
            headers=operator,
        )
        assert upload.status_code == 201
        record_id = upload.json()["id"]
        body = wait_for_processing(client, record_id, reviewer)
        assert body["status"] == "Needs review"
        assert len(body["fields"]) == 12

        stored = next((TEMP_ROOT / "uploads").glob("*.dhara"))
        assert not stored.read_bytes().startswith(b"\x89PNG")

        required_values = {"Landowner name": "Suresh Kumar Patel", "Khasra number": "77/3", "Village": "Baragaon", "District": "Varanasi"}
        for field in body["fields"]:
            if field["label"] in required_values:
                correction = client.patch(
                    f"/api/documents/{record_id}/fields/{field['id']}",
                    json={"value": required_values[field["label"]], "actor": "ignored client actor"},
                    headers=reviewer,
                )
                assert correction.status_code == 200

        approval = client.post(f"/api/documents/{record_id}/approve", json={"actor": "review"}, headers=reviewer)
        assert approval.status_code == 200
        assert approval.json()["status"] == "Verified"
        assert approval.json()["owner"] == "Suresh Kumar Patel"

        source = client.get(f"/api/documents/{record_id}/file", headers=reviewer)
        assert source.status_code == 200
        assert source.content.startswith(b"\x89PNG")

        audit = client.get(f"/api/audit?document_id={record_id}", headers=reviewer)
        event_types = {event["event_type"] for event in audit.json()}
        assert {"upload", "flag", "edit", "approve"}.issubset(event_types)
        versions = client.get(f"/api/documents/{record_id}/versions", headers=reviewer)
        assert versions.status_code == 200
        # Three real field corrections plus the approval; unchanged metadata is not versioned.
        assert len(versions.json()) == 4
        learning_data = client.get("/api/export/corrections.jsonl", headers=auth(client, "admin@dhara.gov.in"))
        assert learning_data.status_code == 200
        assert "Suresh Kumar Patel" in learning_data.text


def test_batch_gis_notifications_and_exports():
    with TestClient(app) as client:
        admin = auth(client, "admin@dhara.gov.in")
        batch = client.post(
            "/api/documents/batch",
            files=[("files", ("one.png", png_bytes(), "image/png")), ("files", ("two.png", png_bytes(), "image/png"))],
            data={"district": "Lucknow", "document_type": "Mutation register", "language": "Hindi"},
            headers=admin,
        )
        assert batch.status_code == 201
        assert len(batch.json()) == 2
        parcels = client.get("/api/parcels", headers=admin)
        assert parcels.status_code == 200
        assert parcels.json()["type"] == "FeatureCollection"
        assert len(parcels.json()["features"]) == 8
        notice_list = client.get("/api/notifications", headers=admin)
        assert notice_list.status_code == 200
        notice_id = notice_list.json()[0]["id"]
        assert client.post(f"/api/notifications/{notice_id}/read", headers=admin).json()["read"] is True
        assert next(item for item in client.get("/api/notifications", headers=admin).json() if item["id"] == notice_id)["read"] is True
        viewer = auth(client, "viewer@dhara.gov.in")
        assert next(item for item in client.get("/api/notifications", headers=viewer).json() if item["id"] == notice_id)["read"] is False
        assert client.get("/api/export/records.csv", headers=admin).headers["content-type"].startswith("text/csv")
        assert client.get("/api/export/parcels.geojson", headers=admin).json()["type"] == "FeatureCollection"
        assert client.get("/api/audit/integrity", headers=admin).json()["valid"] is True
        integrations = client.get("/api/integrations", headers=admin)
        assert integrations.status_code == 200
        assert {item["key"] for item in integrations.json()} == {"LRMS", "DILRMP", "GeoServer", "Registration", "Notifications"}
        assert client.get("/api/integrations", headers=viewer).status_code == 403
        canonical = client.get("/api/integration/records/LR-2026-04181", headers=viewer)
        assert canonical.status_code == 200
        assert canonical.headers["x-dhara-schema-version"] == "1"
        assert canonical.json()["identifiers"]["khasra_number"] == "88/1"
        created_user = client.post("/api/users", headers=admin, json={"username": "district.officer@dhara.gov.in", "display_name": "District Officer", "password": "temporary-password", "role": "Viewer"})
        assert created_user.status_code == 201
        updated_user = client.patch(f"/api/users/{created_user.json()['id']}", headers=admin, json={"role": "Auditor"})
        assert updated_user.json()["role"] == "Auditor"


def create_document(client: TestClient, headers: dict[str, str], district: str) -> str:
    upload = client.post(
        "/api/documents",
        files={"file": ("record.png", png_bytes(), "image/png")},
        data={"state": "Uttar Pradesh", "district": district, "document_type": "Khasra", "language": "English"},
        headers=headers,
    )
    assert upload.status_code == 201
    record_id = upload.json()["id"]
    # Let the background OCR pipeline finish (and mark its ProcessingJob "Completed") before
    # the test submits its own extraction - otherwise the two can race to write document.fields.
    wait_for_processing(client, record_id, headers)
    return record_id


def submit_extraction(client: TestClient, record_id: str, headers: dict[str, str], field_values: dict[str, str], plot_rows: list[dict] | None = None) -> list[dict]:
    fields = [{"label": label, "value": value, "original": value, "confidence": 90, "valid": True, "verified": False} for label, value in field_values.items()]
    response = client.post(
        f"/api/documents/{record_id}/extraction",
        json={"text": "synthetic test text", "engine": "Test harness", "language": "English", "confidence": 90, "fields": fields, "pages": 1, "warnings": [], "plot_rows": plot_rows or []},
        headers=headers,
    )
    assert response.status_code == 200
    return response.json()


def test_ownership_conflict_detection():
    with TestClient(app) as client:
        operator = auth(client, "operator@dhara.gov.in")
        first_id = create_document(client, operator, district="Kanpur")
        second_id = create_document(client, operator, district="Kanpur")

        submit_extraction(client, first_id, operator, {"Landowner name": "Suresh Kumar Patel", "Khasra number": "77/3", "Village": "Baragaon", "District": "Kanpur"})

        # A near-identical khasra (a single mangled digit) but a genuinely different owner -
        # the real ownership-dispute signal, invisible to an exact-match duplicate check.
        conflict = submit_extraction(client, second_id, operator, {"Landowner name": "Mohan Lal Verma", "Khasra number": "77/8", "Village": "Baragaon", "District": "Kanpur"})
        assert "ownership_conflict" in {issue["code"] for issue in conflict[0]["validation_issues"]}


def test_fuzzy_duplicate_detection():
    with TestClient(app) as client:
        operator = auth(client, "operator@dhara.gov.in")
        first_id = create_document(client, operator, district="Lucknow")
        second_id = create_document(client, operator, district="Lucknow")

        submit_extraction(client, first_id, operator, {"Landowner name": "Suresh Kumar Patel", "Khasra number": "55/2", "Village": "Baragaon", "District": "Lucknow"})

        # Same khasra, an OCR-variant of the same owner's name (l/I confusion) - a duplicate
        # entry, not a conflict, and an exact-match check would miss the OCR-mangled owner.
        duplicate = submit_extraction(client, second_id, operator, {"Landowner name": "Suresh Kumar PateI", "Khasra number": "55/2", "Village": "Baragaon", "District": "Lucknow"})
        codes = {issue["code"] for issue in duplicate[0]["validation_issues"]}
        assert "possible_duplicate" in codes
        assert "ownership_conflict" not in codes


def test_plot_row_area_and_intra_batch_duplicate_checks():
    with TestClient(app) as client:
        operator = auth(client, "operator@dhara.gov.in")
        batch_id = create_document(client, operator, district="Meerut")
        rows = [
            {"khata": "10", "khasra": "10/1", "area": "1.2 hectare", "rent": "0", "cess": "0"},
            {"khata": "10", "khasra": "10/2", "area": "not-a-number", "rent": "0", "cess": "0"},
            {"khata": "10", "khasra": "10/1", "area": "0.8 hectare", "rent": "0", "cess": "0"},
        ]
        result = submit_extraction(client, batch_id, operator, {"Landowner name": "Test Owner", "Village": "Test Village", "District": "Meerut"}, plot_rows=rows)
        codes = {issue["code"] for issue in result[0]["validation_issues"]}
        assert "invalid_plot_row_area" in codes
        assert "intra_batch_duplicate_khasra" in codes


def test_cross_modal_geometry_validation():
    with TestClient(app) as client:
        operator = auth(client, "operator@dhara.gov.in")
        reviewer = auth(client, "priya@dhara.gov.in")

        # Auto-discovered by khasra + district against the seeded 89/2 parcel's real mapped
        # geometry - no explicit officer link needed.
        auto_id = create_document(client, operator, district="Varanasi")
        auto_result = submit_extraction(client, auto_id, operator, {"Landowner name": "Geometry Test Owner", "Khasra number": "89/2", "Village": "Baragaon", "District": "Varanasi", "Plot area": "50 hectare"})
        assert "area_geometry_mismatch" in {issue["code"] for issue in auto_result[0]["validation_issues"]}

        # Also re-fires when an officer links a parcel to a record after the fact: nothing to
        # auto-discover at extraction time (no Khasra number captured), only once linked.
        parcels = client.get("/api/parcels", headers=reviewer).json()["features"]
        target = next(feature for feature in parcels if feature["properties"]["khasra"] == "91/1")
        linked_id = create_document(client, operator, district="Varanasi")
        submit_extraction(client, linked_id, operator, {"Landowner name": "Link Test Owner", "Village": "Baragaon", "District": "Varanasi", "Plot area": "40 hectare"})
        before = client.get(f"/api/documents/{linked_id}", headers=reviewer).json()
        assert "area_geometry_mismatch" not in {issue["code"] for issue in before["validation_issues"]}
        assert client.patch(f"/api/parcels/{target['id']}", json={"record_id": linked_id}, headers=reviewer).status_code == 200
        after = client.get(f"/api/documents/{linked_id}", headers=reviewer).json()
        assert "area_geometry_mismatch" in {issue["code"] for issue in after["validation_issues"]}


def test_rejects_disguised_and_unsupported_uploads():
    with TestClient(app) as client:
        operator = auth(client, "operator@dhara.gov.in")
        disguised = client.post(
            "/api/documents",
            files={"file": ("fake.png", b"not-an-image", "image/png")},
            headers=operator,
        )
        assert disguised.status_code == 422
        unsupported = client.post(
            "/api/documents",
            files={"file": ("malware.exe", b"MZ", "application/octet-stream")},
            headers=operator,
        )
        assert unsupported.status_code == 415
