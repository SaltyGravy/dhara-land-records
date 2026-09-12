# Dhara — Intelligent Land Records

Dhara is a deployed full-stack prototype for intelligent land-record digitization and validation. It has a React application, a Cloudflare Worker-compatible hosted API backed by D1 and R2, and an optional FastAPI/PostgreSQL deployment profile.

## Included in the MVP

- Operational dashboard with digitization and AI-accuracy metrics
- PBKDF2 authentication, revocable sessions, persistent rate limiting, government OpenID Connect integration, and five enforced user roles
- Batch PDF/image intake with content validation and optional ClamAV scanning
- AES-256-GCM protected document storage and SHA-256 integrity checks
- Recoverable database-backed processing jobs with retry tracking
- Online PDF text-layer extraction plus enhanced multilingual Tesseract.js OCR for scans and images
- Multiscript extraction into a canonical 12-field schema covering owner, ownership, survey, khasra, khata, area, jurisdiction, classification, mutation, and registration data
- Side-by-side source document and extracted-field verification
- Confidence scoring, required-field rules, area checks, and duplicate warnings
- Searchable land-record repository
- Database-backed GeoJSON cadastral parcel view, validated parcel import, record linking, and officer editing
- CSV and GeoJSON exports
- Persisted notifications, corrections, approvals, rejections, and record versions
- Administrator user lifecycle controls, integration health tests, idempotent record synchronization, and integration run history
- Per-record canonical JSON for LRMS/DILRMP/registration/GIS adapters, external validation hooks, and notification gateway delivery
- Human-verified correction memory that reuses confirmed language- and field-specific patterns and exposes evaluation metrics
- Privacy-preserving citizen request and tracking portal with encrypted contact and request details
- Daily protected database backups, retention cleanup, manual backup controls, and operational health metrics
- HMAC-SHA256 chained audit events with integrity verification
- Responsive navigation for desktop, tablet, and mobile

Hosted uploads are encrypted before being written to private R2 objects; structured records, processing state, audit data, corrections, sessions, integration runs, and citizen requests persist in D1. The FastAPI profile encrypts generated storage files in `data/uploads` and stores records in SQLite or PostgreSQL. Neither runtime trusts an uploaded filename as a storage path.

## Online prototype

The owner-private production deployment is available at:

`https://dhara-land-records-india.aditipandey09.chatgpt.site`

Online OCR runs on the operator's device so document pixels are not sent to an additional OCR API. Tesseract language assets are loaded only when processing starts, and the extracted text and structured result are persisted through the authenticated API.

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

This starts PostgreSQL and the application at `http://localhost:8000`. The container includes Poppler and Tesseract packs for all languages listed above.

## Tests

```bash
npm run build
.venv/bin/python -m pytest -q
npm run test:ui
BASE_URL=http://127.0.0.1:4173 npm run test:ocr-ui
```

The browser tests check login, dashboard data, complete records, the 12-field schema, GIS, audit navigation, administrator controls, citizen services, browser-console errors, and a real OCR upload with extracted owner and khasra values.

## External activation inputs

The software paths are implemented, but the following integrations remain inactive until their owners supply external resources:

1. An OpenID Connect issuer, client ID, client secret, redirect registration, and authorized official email mappings for government SSO.
2. Agency base URLs, credentials, schemas, and sandbox access for LRMS, DILRMP, registration, GeoServer, and notification delivery.
3. An HTTPS malware-scanning service if hosted antivirus is required in addition to file-signature validation.
4. Authoritative cadastral GeoJSON/GeoServer layers and jurisdiction master data for the target deployment.
5. Labelled, legally usable state-specific printed and handwriting datasets for trained-model benchmarking or replacement of the included OCR engine.
6. The hosting authority's backup destination, retention policy, disaster-recovery targets, monitoring service, and security-accreditation process.

These are activation and governance dependencies rather than missing application routes. Until configured, the administration screen reports each connector as `Needs endpoint` and internal validation continues without fabricating an external verification result.
