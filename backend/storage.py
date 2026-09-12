import hashlib
import io
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from PIL import Image, UnidentifiedImageError


HEADER = b"DHARA1"
KEY_MATERIAL = os.getenv("FILE_ENCRYPTION_KEY", os.getenv("TOKEN_SECRET", "development-only-change-this-secret"))
ENCRYPTION_KEY = hashlib.sha256(KEY_MATERIAL.encode()).digest()


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
    destination.write_bytes(HEADER + nonce + encrypted)
    return hashlib.sha256(content).hexdigest()


def read_and_decrypt(path: Path) -> bytes:
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

