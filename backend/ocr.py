import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from pypdf import PdfReader
from PIL import Image, ImageEnhance, ImageFilter, ImageOps


LANGUAGE_CODES = {
    "Assamese": "asm+eng",
    "Bengali": "ben+eng",
    "Gujarati": "guj+eng",
    "Hindi": "hin+eng",
    "Kannada": "kan+eng",
    "Malayalam": "mal+eng",
    "Marathi": "mar+eng",
    "Odia": "ori+eng",
    "Punjabi": "pan+eng",
    "Sanskrit": "san+eng",
    "Tamil": "tam+eng",
    "Telugu": "tel+eng",
    "Urdu": "urd+eng",
    "English": "eng",
    "Auto-detect": "hin+eng",
}


def detect_language(text: str, fallback: str) -> str:
    script_ranges = [
        (r"[\u0980-\u09ff]", "Bengali"), (r"[\u0a00-\u0a7f]", "Punjabi"),
        (r"[\u0a80-\u0aff]", "Gujarati"), (r"[\u0b00-\u0b7f]", "Odia"),
        (r"[\u0b80-\u0bff]", "Tamil"), (r"[\u0c00-\u0c7f]", "Telugu"),
        (r"[\u0c80-\u0cff]", "Kannada"), (r"[\u0d00-\u0d7f]", "Malayalam"),
    ]
    for pattern, language in script_ranges:
        if re.search(pattern, text):
            return language
    if re.search(r"[\u0900-\u097f]", text):
        return fallback if fallback in {"Hindi", "Marathi", "Sanskrit"} else "Hindi"
    if re.search(r"[\u0600-\u06ff]", text):
        return "Urdu"
    if re.search(r"[A-Za-z]", text):
        return "English"
    return fallback if fallback != "Auto-detect" else "Unknown"


def _preprocess_image(source: Path, destination: Path) -> None:
    with Image.open(source) as image:
        image = ImageOps.exif_transpose(image)
        image = ImageOps.grayscale(image)
        if max(image.size) < 1800:
            image = image.resize((image.width * 2, image.height * 2), Image.Resampling.LANCZOS)
        image = ImageOps.autocontrast(image, cutoff=1)
        image = image.filter(ImageFilter.MedianFilter(size=3))
        image = ImageEnhance.Sharpness(image).enhance(1.8)
        image.save(destination, format="PNG", optimize=True)


def _run_tesseract(image: Path, language: str) -> str:
    lang = LANGUAGE_CODES.get(language, "hin+eng")
    available = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, check=False).stdout
    requested = [code for code in lang.split("+") if code in available.splitlines()]
    if not requested:
        requested = ["eng"] if "eng" in available.splitlines() else []
    with tempfile.TemporaryDirectory(prefix="dhara-enhance-") as temp_dir:
        enhanced = Path(temp_dir) / "enhanced.png"
        try:
            _preprocess_image(image, enhanced)
            ocr_source = enhanced
        except Exception:
            ocr_source = image
        command = ["tesseract", str(ocr_source), "stdout", "--psm", "6", "-c", "preserve_interword_spaces=1"]
        if requested:
            command.extend(["-l", "+".join(requested)])
        result = subprocess.run(command, capture_output=True, text=True, timeout=120, check=False)
        return result.stdout.strip()


def extract_text(path: Path, mime_type: str, language: str) -> tuple[str, str]:
    if mime_type == "application/pdf" or path.suffix.lower() == ".pdf":
        try:
            text = "\n".join(page.extract_text() or "" for page in PdfReader(path).pages).strip()
            if len(text) >= 30:
                return text, "PDF text layer"
        except Exception:
            text = ""

        if shutil.which("tesseract") and shutil.which("pdftoppm"):
            with tempfile.TemporaryDirectory(prefix="dhara-ocr-") as temp_dir:
                prefix = Path(temp_dir) / "page"
                subprocess.run(["pdftoppm", "-jpeg", "-r", "200", str(path), str(prefix)], capture_output=True, timeout=180, check=False)
                pages = sorted(Path(temp_dir).glob("page-*.jpg"))
                return "\n".join(_run_tesseract(page, language) for page in pages).strip(), "Tesseract OCR"
        return text, "OCR unavailable"

    if shutil.which("tesseract"):
        return _run_tesseract(path, language), "Tesseract OCR"
    return "", "OCR unavailable"


FIELD_RULES: list[tuple[str, list[str]]] = [
    ("Landowner name", [
        r"(?:land\s*owner|owner(?:\s+name)?|recorded\s+owner)\s*[:\-]?\s*([^\n|,;]{3,80})",
        r"(?:खातेदार(?:\s+का\s+नाम)?|भूस्वामी|मालिक)\s*[:\-]?\s*([^\n|,;]{2,80})",
    ]),
    ("Survey number", [r"(?:survey)(?:\s+(?:no|number|संख्या|सं))?\s*[:\-]?\s*([A-Za-z0-9०-९/\-]+)", r"सर्वे(?:\s+(?:संख्या|सं))?\s*[:\-]?\s*([A-Za-z0-9०-९/\-]+)"]),
    ("Khasra number", [r"(?:khasra)(?:\s+(?:no|number|संख्या|सं))?\s*[:\-]?\s*([A-Za-z0-9०-९/\-]+)", r"खसरा(?:\s+(?:संख्या|सं))?\s*[:\-]?\s*([A-Za-z0-9०-९/\-]+)"]),
    ("Khata number", [r"(?:khata|khatauni)(?:\s+(?:no|number|संख्या|सं))?\s*[:\-]?\s*([A-Za-z0-9०-९/\-]+)", r"खाता(?:\s+(?:संख्या|सं))?\s*[:\-]?\s*([A-Za-z0-9०-९/\-]+)"]),
    ("Plot area", [r"(?:plot\s+area|area|क्षेत्रफल)\s*[:\-]?\s*([0-9०-९.]+\s*(?:hectare|hectares|ha|हे|हे०|acre|acres|sq\.?\s*m)?)"]),
    ("Village", [r"(?:village|ग्राम|गाँव)\s*[:\-]?\s*([^\n|,;]{2,60})"]),
    ("Tehsil", [r"(?:tehsil|taluka|तहसील)\s*[:\-]?\s*([^\n|,;]{2,60})"]),
    ("District", [r"(?:district|जिला|जनपद)\s*[:\-]?\s*([^\n|,;]{2,60})"]),
    ("Land classification", [r"(?:land\s+classification|land\s+type|भूमि\s+का\s+प्रकार|भूमि\s+वर्ग)\s*[:\-]?\s*([^\n|,;]{2,80})"]),
    ("Ownership details", [r"(?:ownership(?:\s+details)?|tenure|अधिकार(?:\s+विवरण)?|स्वामित्व)\s*[:\-]?\s*([^\n|,;]{2,120})"]),
    ("Mutation reference", [r"(?:mutation(?:\s+reference)?|नामांतरण(?:\s+आदेश)?)(?:\s+(?:no|number|संख्या|सं))?\s*[:\-]?\s*([A-Za-z0-9०-९/\-]+)"]),
    ("Registration information", [r"(?:registration(?:\s+(?:number|no|details|information))?|registry(?:\s+(?:number|no))?|पंजीकरण(?:\s+(?:संख्या|विवरण))?|रजिस्ट्री(?:\s+संख्या)?)\s*[:\-]?\s*([^\n|,;]{2,120})"]),
]


def extract_fields(text: str, district: str) -> list[dict]:
    compact = re.sub(r"[ \t]+", " ", text)
    fields: list[dict] = []
    for label, patterns in FIELD_RULES:
        match = next((match for pattern in patterns if (match := re.search(pattern, compact, flags=re.IGNORECASE))), None)
        if match:
            value = match.group(1).strip(" .:-")
            confidence = 91.0 if label in {"District", "Village", "Survey number", "Khasra number", "Khata number"} else 86.0
            fields.append({"label": label, "value": value, "original": match.group(0).strip(), "confidence": confidence, "valid": True})
        elif label == "District" and district != "Unassigned":
            fields.append({"label": label, "value": district, "original": "Upload metadata", "confidence": 100.0, "valid": True})
        else:
            fields.append({"label": label, "value": "", "original": "Not detected", "confidence": 0.0, "valid": False})
    return fields
