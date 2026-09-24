import io
import os
import tempfile
import threading
import time
from pathlib import Path

import pytest
import uvicorn
from fastapi.testclient import TestClient
from PIL import Image

from scripts.mock_lrms import app as mock_lrms_app


TEMP_ROOT = Path(tempfile.mkdtemp(prefix="dhara-tests-"))
os.environ["DATABASE_URL"] = f"sqlite:///{TEMP_ROOT / 'test.db'}"
os.environ["UPLOAD_DIR"] = str(TEMP_ROOT / "uploads")
os.environ["DEMO_PASSWORD"] = "test-password"
os.environ["TOKEN_SECRET"] = "test-token-secret-with-sufficient-entropy"
os.environ["FILE_ENCRYPTION_KEY"] = "test-file-key-with-sufficient-entropy"

from backend.app import app, rate_windows


@pytest.fixture(autouse=True)
def _reset_rate_limits():
    # rate_windows is process-global (keyed by client host), so it otherwise accumulates
    # across every test in the same pytest run - enough tests each logging in a few times
    # trips the real 20/minute login limit well before any single test does anything wrong.
    rate_windows.clear()
    yield


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


def test_model_metrics_computes_learned_patterns_from_real_corrections():
    with TestClient(app) as client:
        operator = auth(client, "operator@dhara.gov.in")
        reviewer = auth(client, "priya@dhara.gov.in")
        auditor = auth(client, "admin@dhara.gov.in")

        baseline = client.get("/api/model/metrics", headers=auditor).json()
        assert baseline["learned_patterns"] == []
        assert baseline["learned_patterns_message"]

        # Confirm the same correction on two separate documents - ADAPTIVE_THRESHOLD is 2, so
        # this is exactly what should turn it into a reported "learned pattern".
        for district in ("Noida", "Agra"):
            record_id = create_document(client, operator, district=district)
            submit_extraction(client, record_id, operator, {"Landowner name": "Owner", "Khasra number": "88/8", "Village": "V", "District": district})
            document = client.get(f"/api/documents/{record_id}", headers=reviewer).json()
            field = next(item for item in document["fields"] if item["label"] == "Khasra number")
            correction = client.patch(f"/api/documents/{record_id}/fields/{field['id']}", json={"value": "88/1", "actor": "reviewer"}, headers=reviewer)
            assert correction.status_code == 200

        metrics = client.get("/api/model/metrics", headers=auditor).json()
        entry = next((row for row in metrics["learned_patterns"] if row["field_label"] == "Khasra number" and row["corrected_value"] == "88/1"), None)
        assert entry is not None
        assert entry["occurrences"] >= 2
        assert metrics["learned_patterns_message"] is None


def test_integration_test_and_sync_against_a_real_mock_connector():
    # Runs the actual mock LRMS service (scripts/mock_lrms.py) on a real local socket and
    # points the app's LRMS connector at it - this exercises the real outbound HTTP call
    # (backend.app._call_external_json), not a mocked-out version of it.
    server = uvicorn.Server(uvicorn.Config(mock_lrms_app, host="127.0.0.1", port=8971, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(.05)
        assert server.started, "mock LRMS server did not start"
        os.environ["LRMS_BASE_URL"] = "http://127.0.0.1:8971"
        with TestClient(app) as client:
            admin = auth(client, "admin@dhara.gov.in")
            operator = auth(client, "operator@dhara.gov.in")

            probe = client.post("/api/integrations/LRMS/test", headers=admin)
            assert probe.status_code == 200
            assert probe.json()["connected"] is True

            record_id = create_document(client, operator, district="Kanpur")
            sync = client.post(f"/api/integrations/LRMS/sync/{record_id}", headers=admin)
            assert sync.status_code == 200
            body = sync.json()
            assert body["synchronized"] is True
            assert body["response"]["accepted"] is True
            assert body["response"]["lrms_reference"] == f"LRMS-{record_id}"
    finally:
        os.environ.pop("LRMS_BASE_URL", None)
        server.should_exit = True
        thread.join(timeout=5)


def test_login_and_me_report_the_users_own_state():
    with TestClient(app) as client:
        # A user's state comes back on both auth endpoints, not just enforced silently on
        # the backend - the frontend upload lock and sidebar label depend on this value.
        login = client.post("/api/auth/login", json={"username": "mumbai.operator@dhara.gov.in", "password": "test-password"})
        assert login.status_code == 200
        assert login.json()["user"]["state"] == "Maharashtra"
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        assert client.get("/api/auth/me", headers=headers).json()["state"] == "Maharashtra"

        national = client.post("/api/auth/login", json={"username": "admin@dhara.gov.in", "password": "test-password"})
        assert national.json()["user"]["state"] is None


def test_state_scoping_isolates_documents_across_states():
    with TestClient(app) as client:
        national_admin = auth(client, "admin@dhara.gov.in")
        up_operator = auth(client, "operator@dhara.gov.in")
        mh_operator = auth(client, "mumbai.operator@dhara.gov.in")

        up_upload = client.post(
            "/api/documents", files={"file": ("record.png", png_bytes(), "image/png")},
            data={"state": "Uttar Pradesh", "district": "Kanpur", "document_type": "Khasra", "language": "English"},
            headers=up_operator,
        )
        assert up_upload.status_code == 201
        up_id = up_upload.json()["id"]

        # A Maharashtra operator's upload is forced to Maharashtra server-side even if the
        # client claims otherwise - the state field is a boundary, not a suggestion.
        mh_upload = client.post(
            "/api/documents", files={"file": ("record.png", png_bytes(), "image/png")},
            data={"state": "Uttar Pradesh", "district": "Pune", "document_type": "Khasra", "language": "English"},
            headers=mh_operator,
        )
        assert mh_upload.status_code == 201
        mh_id = mh_upload.json()["id"]
        assert client.get(f"/api/documents/{mh_id}", headers=mh_operator).json()["district"] == "Pune"

        up_visible = {doc["id"] for doc in client.get("/api/documents", headers=up_operator).json()}
        mh_visible = {doc["id"] for doc in client.get("/api/documents", headers=mh_operator).json()}
        assert up_id in up_visible and mh_id not in up_visible
        assert mh_id in mh_visible and up_id not in mh_visible

        # A state-scoped user gets a 404, not a 403, for a record in another state - it
        # shouldn't even confirm the record ID is real.
        assert client.get(f"/api/documents/{mh_id}", headers=up_operator).status_code == 404
        assert client.get(f"/api/documents/{up_id}", headers=mh_operator).status_code == 404

        # A national administrator (state is None) sees every state.
        national_visible = {doc["id"] for doc in client.get("/api/documents", headers=national_admin).json()}
        assert {up_id, mh_id}.issubset(national_visible)

        # Stats scope the same way.
        up_stats = client.get("/api/stats", headers=up_operator).json()
        mh_stats = client.get("/api/stats", headers=mh_operator).json()
        assert not any(row["name"] == "Pune" for row in up_stats["district_progress"])
        assert not any(row["name"] == "Kanpur" for row in mh_stats["district_progress"])


def test_national_account_is_confined_to_the_state_portal_it_signed_in_through():
    with TestClient(app) as client:
        # A national account (state is None) signing in via a state's branded portal URL -
        # e.g. /maharashtra - is confined to that state for the session, without needing a
        # separate account. Its own account-level state (None) is untouched.
        portal_login = client.post(
            "/api/auth/login",
            json={"username": "admin@dhara.gov.in", "password": "test-password", "portal_state": "Maharashtra"},
        )
        assert portal_login.status_code == 200
        assert portal_login.json()["user"]["state"] == "Maharashtra"
        portal_headers = {"Authorization": f"Bearer {portal_login.json()['access_token']}"}
        assert client.get("/api/auth/me", headers=portal_headers).json()["state"] == "Maharashtra"

        up_operator = auth(client, "operator@dhara.gov.in")
        up_upload = client.post(
            "/api/documents", files={"file": ("record.png", png_bytes(), "image/png")},
            data={"state": "Uttar Pradesh", "district": "Kanpur", "document_type": "Khasra", "language": "English"},
            headers=up_operator,
        )
        assert up_upload.status_code == 201
        up_id = up_upload.json()["id"]

        # Even though this is a national administrator account, signed in through the
        # Maharashtra portal it cannot see (or reach) a Uttar Pradesh record this session.
        portal_visible = {doc["id"] for doc in client.get("/api/documents", headers=portal_headers).json()}
        assert up_id not in portal_visible
        assert client.get(f"/api/documents/{up_id}", headers=portal_headers).status_code == 404

        # A plain login with no portal_state keeps full national access, unaffected.
        national_headers = auth(client, "admin@dhara.gov.in")
        national_visible = {doc["id"] for doc in client.get("/api/documents", headers=national_headers).json()}
        assert up_id in national_visible


def test_category_field_round_trips_through_upload_and_filters_parcels():
    with TestClient(app) as client:
        up_operator = auth(client, "operator@dhara.gov.in")
        urban_upload = client.post(
            "/api/documents", files={"file": ("record.png", png_bytes(), "image/png")},
            data={"state": "Uttar Pradesh", "district": "Kanpur", "category": "Urban", "document_type": "Khasra", "language": "English"},
            headers=up_operator,
        )
        assert urban_upload.status_code == 201
        assert urban_upload.json()["category"] == "Urban"

        # An unrecognized category value falls back to Rural rather than being stored verbatim.
        bogus_upload = client.post(
            "/api/documents", files={"file": ("record.png", png_bytes(), "image/png")},
            data={"state": "Uttar Pradesh", "district": "Kanpur", "category": "Commercial", "document_type": "Khasra", "language": "English"},
            headers=up_operator,
        )
        assert bogus_upload.status_code == 201
        assert bogus_upload.json()["category"] == "Rural"

        rural_only = client.get("/api/parcels?category=Rural", headers=up_operator).json()
        assert all(feature["properties"]["category"] == "Rural" for feature in rural_only["features"])
        urban_only = client.get("/api/parcels?category=Urban", headers=up_operator).json()
        assert all(feature["properties"]["category"] == "Urban" for feature in urban_only["features"])


def test_state_scoped_administrator_manages_only_same_state_users():
    with TestClient(app) as client:
        national_admin = auth(client, "admin@dhara.gov.in")
        created = client.post(
            "/api/users", headers=national_admin,
            json={"username": "mh.admin@dhara.gov.in", "display_name": "Maharashtra Admin", "password": "test-password", "role": "Administrator", "state": "Maharashtra"},
        )
        assert created.status_code == 201
        assert created.json()["state"] == "Maharashtra"

        mh_admin = auth(client, "mh.admin@dhara.gov.in")
        # Creating a user while state-scoped is forced into the acting admin's own state,
        # regardless of what the request body claims.
        rogue = client.post(
            "/api/users", headers=mh_admin,
            json={"username": "sneaky@dhara.gov.in", "display_name": "Sneaky", "password": "temporary-password", "role": "Viewer", "state": "Uttar Pradesh"},
        )
        assert rogue.status_code == 403

        scoped_created = client.post(
            "/api/users", headers=mh_admin,
            json={"username": "mh.viewer@dhara.gov.in", "display_name": "Maharashtra Viewer", "password": "temporary-password", "role": "Viewer"},
        )
        assert scoped_created.status_code == 201
        assert scoped_created.json()["state"] == "Maharashtra"

        # The state-scoped admin's user list never includes Uttar Pradesh staff.
        visible_usernames = {user["username"] for user in client.get("/api/users", headers=mh_admin).json()}
        assert "mh.viewer@dhara.gov.in" in visible_usernames
        assert "operator@dhara.gov.in" not in visible_usernames


def test_registry_flag_blocks_approval_until_resolved():
    with TestClient(app) as client:
        reviewer = auth(client, "priya@dhara.gov.in")
        admin = auth(client, "admin@dhara.gov.in")

        # LR-2026-04181 (khasra 88/1, Varanasi) is seeded with an active mortgage flag on file.
        blocked = client.post("/api/documents/LR-2026-04181/approve", json={"actor": "reviewer"}, headers=reviewer)
        assert blocked.status_code == 409
        blocking_codes = {issue["code"] for issue in blocked.json()["detail"]["issues"]}
        assert "registry_flag" in blocking_codes

        flags = client.get("/api/registry-flags?status=Active", headers=admin).json()
        flag = next(item for item in flags if item["khasra_number"] == "88/1" and item["district"] == "Varanasi")
        resolved = client.patch(f"/api/registry-flags/{flag['id']}", json={"status": "Resolved"}, headers=admin)
        assert resolved.status_code == 200

        document = client.get("/api/documents/LR-2026-04181", headers=reviewer).json()
        assert "registry_flag" not in {issue["code"] for issue in document["validation_issues"]}


def test_creating_a_registry_flag_immediately_flags_a_matching_document():
    with TestClient(app) as client:
        operator = auth(client, "operator@dhara.gov.in")
        reviewer = auth(client, "priya@dhara.gov.in")
        record_id = create_document(client, operator, district="Sitapur")
        submit_extraction(client, record_id, operator, {"Landowner name": "Test Owner", "Khasra number": "200/1", "Village": "Test Village", "District": "Sitapur"})

        created = client.post(
            "/api/registry-flags", headers=reviewer,
            json={"district": "Sitapur", "khasra_number": "200/1", "flag_type": "Dispute", "reference": "CASE/2026/41"},
        )
        assert created.status_code == 201
        assert created.json()["state"] == "Uttar Pradesh"

        document = client.get(f"/api/documents/{record_id}", headers=reviewer).json()
        assert "registry_flag" in {issue["code"] for issue in document["validation_issues"]}


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
