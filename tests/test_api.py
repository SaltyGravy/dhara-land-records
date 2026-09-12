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
