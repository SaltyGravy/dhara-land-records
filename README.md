# Dhara — Intelligent Land Records

Dhara is a working vertical-slice MVP for intelligent land-record digitization and validation. It includes a React application and a FastAPI service backed by SQLite locally or PostgreSQL in deployed environments.

## Included in the MVP

- Operational dashboard with digitization and AI-accuracy metrics
- JWT authentication with five enforced user roles
- Batch PDF/image intake with content validation and optional ClamAV scanning
- AES-256-GCM encrypted document storage and SHA-256 integrity checks
- Recoverable database-backed processing jobs with retry tracking
- PDF text-layer extraction and optional enhanced Tesseract image OCR
- Rule-based extraction into a canonical 12-field schema covering owner, ownership, survey, khasra, khata, area, jurisdiction, classification, mutation, and registration data
- Side-by-side source document and extracted-field verification
- Confidence scoring, required-field rules, area checks, and duplicate warnings
- Searchable land-record repository
- Database-backed GeoJSON cadastral parcel view
- CSV and GeoJSON exports
- Persisted notifications, corrections, approvals, rejections, and record versions
- Administrator user lifecycle controls and deployment integration readiness
- Per-record canonical JSON for LRMS/DILRMP adapters and JSONL correction-data export for governed model retraining
- HMAC-SHA256 chained audit events with integrity verification
- Responsive navigation for desktop, tablet, and mobile

Uploaded files are encrypted under generated storage names in `data/uploads`, and structured records are stored in `data/dhara.db`. Both paths are ignored by Git. The API never trusts an uploaded filename as a storage path.

## Run locally

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
npm install
npm run dev:all
```

Open `http://localhost:5173`. The API is available at `http://localhost:8000`, with interactive documentation at `http://localhost:8000/docs`.

Development login:

```text
Email:    admin@dhara.gov.in
Password: Dhara@2026
```

Other seeded roles use the same development password: `priya@dhara.gov.in`, `operator@dhara.gov.in`, `auditor@dhara.gov.in`, and `viewer@dhara.gov.in`. Set `DEMO_PASSWORD` before the first startup to change it. These accounts are for local evaluation only.

Text-based PDFs work without Tesseract. Scans use enhancement, contrast correction, denoising, sharpening, and Tesseract when installed. Language mappings cover Assamese, Bengali, English, Gujarati, Hindi, Kannada, Malayalam, Marathi, Odia, Punjabi, Sanskrit, Tamil, Telugu, and Urdu when the matching Tesseract language packs are available. Scans uploaded on a host without OCR are persisted and routed to manual review rather than producing fabricated values.

## Production build

```bash
npm run build
.venv/bin/python -m uvicorn backend.app:app --port 8000
```

After the front end is built, FastAPI serves the complete application at `http://localhost:8000`.

## PostgreSQL

Set a PostgreSQL connection URL before starting the API:

```bash
export DATABASE_URL='postgresql+psycopg://dhara:change-me@localhost:5432/dhara'
```

Tables and idempotent local schema upgrades are applied automatically. A formally governed deployment should move these upgrades to its standard migration service.

## Container deployment

Copy `.env.example` values into a secure environment and replace every development secret, then run:

```bash
docker compose up --build
```

This starts PostgreSQL and the application at `http://localhost:8000`. The container includes Poppler plus English and Hindi Tesseract packs.

## Tests

```bash
npm run build
.venv/bin/python -m pytest -q
npm run test:ui
```

The UI smoke test uses Chrome and checks login, live dashboard data, complete record details, the 12-field schema, GIS loading, audit navigation, administrator controls, and browser-console errors.

## Next implementation phase

The remaining items require external infrastructure, agency credentials, or labelled training data:

1. Government SSO and identity-provider integration.
2. S3/MinIO key-management integration and a deployed ClamAV service.
3. Trained layout and handwriting models with state-specific benchmark datasets.
4. Agency-specific authentication and field mappings for the provided LRMS, DILRMP, registration, and notification endpoints. The canonical integration API and configuration status are implemented.
5. GeoServer/PostGIS cadastral services and authoritative survey layers.
6. Multi-node workers, backups, disaster recovery, centralized monitoring, and security accreditation.
