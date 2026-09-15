import hashlib
import io
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from PIL import Image, UnidentifiedImageError
from vercel import blob as vercel_blob
from vercel.blob.errors import BlobNotFoundError


HEADER = b"DHARA1"
KEY_MATERIAL = os.getenv("FILE_ENCRYPTION_KEY", os.getenv("TOKEN_SECRET", "development-only-change-this-secret"))
ENCRYPTION_KEY = hashlib.sha256(KEY_MATERIAL.encode()).digest()

# A local uploads directory (as used outside Vercel, or in Vercel's own ephemeral /tmp
# fallback) does not survive a redeploy, a cold start on a different instance, or the
# process simply being torn down - any file a real user uploads would vanish. Vercel Blob
# is real persistent storage; use it whenever a token is configured, and only fall back to
# the local filesystem (e.g. for local dev without a Blob store) when it isn't.
BLOB_ENABLED = bool(os.getenv("BLOB_READ_WRITE_TOKEN"))


def validate_document(content: bytes, extension: str) -> None:
    if extension == ".pdf":
        if not content.startswith(b"%PDF-"):
            raise ValueError("The uploaded file is not a valid PDF")
        return
    try:
        with Image.open(io.BytesIO(content)) as image:
            image.verify()
            expected = {".png": {"PNG"}, ".jpg": {"JPEG"}, ".jpeg": {"JPEG"}, ".tif": {"TIFF"}, ".tiff": {"TIFF"}}
            if image.format not in expected.get(extension, set()):
                raise ValueError("The file content does not match its extension")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("The uploaded image is damaged or unsupported") from exc


def malware_scan(content: bytes) -> str:
    if not shutil.which("clamscan"):
        return "scanner-unavailable"
    with tempfile.NamedTemporaryFile(prefix="dhara-scan-", delete=True) as candidate:
        candidate.write(content)
        candidate.flush()
        result = subprocess.run(["clamscan", "--no-summary", candidate.name], capture_output=True, text=True, timeout=60, check=False)
        if result.returncode == 1:
            raise ValueError("The uploaded file failed malware scanning")
        if result.returncode > 1:
            raise ValueError("The malware scanner could not verify this file")
    return "clean"


def encrypt_and_store(destination: Path, content: bytes) -> str:
    nonce = os.urandom(12)
    encrypted = AESGCM(ENCRYPTION_KEY).encrypt(nonce, content, None)
    payload = HEADER + nonce + encrypted
    if BLOB_ENABLED:
        # destination.name (a server-generated "<hex>.dhara" key, never derived from the
        # uploaded filename) doubles as the Blob pathname - callers don't need to change.
        vercel_blob.put(destination.name, payload, access="private", content_type="application/octet-stream", overwrite=True)
    else:
        destination.write_bytes(payload)
    return hashlib.sha256(content).hexdigest()


def read_and_decrypt(path: Path) -> bytes:
    if BLOB_ENABLED:
        try:
            payload = vercel_blob.get(path.name, access="private").content
        except BlobNotFoundError as exc:
            raise ValueError("Stored document is invalid") from exc
    else:
        payload = path.read_bytes()
    if not payload.startswith(HEADER) or len(payload) < len(HEADER) + 13:
        raise ValueError("Stored document is invalid")
    offset = len(HEADER)
    nonce = payload[offset:offset + 12]
    return AESGCM(ENCRYPTION_KEY).decrypt(nonce, payload[offset + 12:], None)


def materialize_decrypted(path: Path, suffix: str):
    class DecryptedFile:
        def __init__(self):
            self._temp = tempfile.NamedTemporaryFile(prefix="dhara-decrypted-", suffix=suffix, delete=False)
            self.path = Path(self._temp.name)

        def __enter__(self) -> Path:
            self._temp.write(read_and_decrypt(path))
            self._temp.close()
            return self.path

        def __exit__(self, *_):
            self.path.unlink(missing_ok=True)

    return DecryptedFile()

