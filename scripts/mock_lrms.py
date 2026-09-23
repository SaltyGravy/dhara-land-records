"""A stand-in for a ministry LRMS/DILRMP sandbox, so the integration adapter has something
real to talk to during a demo instead of a silent 503.

    uvicorn scripts.mock_lrms:app --port 9100
    export LRMS_BASE_URL=http://127.0.0.1:9100
    # then POST /api/integrations/LRMS/test or /sync/<document_id> against the real app

Accepts exactly the envelope Dhara's own /api/integration/records/{id} already produces
(backend.app.canonical_record_payload) and echoes back an acknowledgement in the shape a
real registry connector would - nothing here is Dhara's contract guess, it's the same
payload the app builds for itself.
"""

from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException

app = FastAPI(title="Mock LRMS sandbox")
received: dict[str, dict] = {}


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "mock-lrms"}


@app.post("/records")
def accept_record(payload: dict) -> dict:
    if payload.get("schema") != "https://dhara.gov.in/schemas/land-record/v1":
        raise HTTPException(status_code=422, detail="Unrecognized record schema")
    record_id = payload.get("record_id")
    if not record_id:
        raise HTTPException(status_code=422, detail="record_id is required")
    lrms_reference = f"LRMS-{record_id}"
    received[record_id] = payload
    return {"accepted": True, "lrms_reference": lrms_reference, "received_at": datetime.now(timezone.utc).isoformat()}


@app.get("/records/{record_id}")
def get_record(record_id: str) -> dict:
    if record_id not in received:
        raise HTTPException(status_code=404, detail="No record synchronized with that id")
    return received[record_id]
