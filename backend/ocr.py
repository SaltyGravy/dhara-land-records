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


# A word-confidence span: the [start, end) character range it occupies in the reconstructed
# text this module hands back, and Tesseract's own 0-100 confidence for that word.
WordConfidence = tuple[int, int, float]


def _parse_tsv(tsv_text: str) -> tuple[str, list[WordConfidence]]:
    """Reconstruct page text from Tesseract's TSV output, alongside each recognized word's
    confidence and its character offsets in that reconstructed text - so a field's extracted
    value can be scored against the actual OCR confidence of the words it came from, rather
    than a single page-wide average."""
    lines = tsv_text.splitlines()
    if len(lines) < 2:
        return "", []
    header = lines[0].split("\t")
    try:
        col = {name: header.index(name) for name in ("level", "line_num", "par_num", "block_num", "conf", "text")}
    except ValueError:
        return "", []
    parts: list[str] = []
    spans: list[WordConfidence] = []
    position = 0
    current_line_key: tuple[str, str, str] | None = None
    for row in lines[1:]:
        cols = row.split("\t")
        if len(cols) <= max(col.values()) or cols[col["level"]] != "5":
            continue
        word = cols[col["text"]]
        try:
            confidence = float(cols[col["conf"]])
        except ValueError:
            confidence = -1
        if not word or confidence < 0:
            continue
        line_key = (cols[col["block_num"]], cols[col["par_num"]], cols[col["line_num"]])
        if current_line_key is None:
            pass
        elif line_key != current_line_key:
            parts.append("\n")
            position += 1
        else:
            parts.append(" ")
            position += 1
        parts.append(word)
        spans.append((position, position + len(word), confidence))
        position += len(word)
        current_line_key = line_key
    return "".join(parts), spans


def _run_tesseract(image: Path, language: str) -> tuple[str, list[WordConfidence]]:
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
        command.append("tsv")
        result = subprocess.run(command, capture_output=True, text=True, timeout=120, check=False)
        return _parse_tsv(result.stdout)


def extract_text(path: Path, mime_type: str, language: str) -> tuple[str, str, list[WordConfidence]]:
    if mime_type == "application/pdf" or path.suffix.lower() == ".pdf":
        try:
            text = "\n".join(page.extract_text() or "" for page in PdfReader(path).pages).strip()
            if len(text) >= 30:
                # Extracted straight from the PDF's text layer, not recognized - there is no
                # OCR confidence to attach; extract_fields treats the absence as "not OCR'd".
                return text, "PDF text layer", []
        except Exception:
            text = ""

        if shutil.which("tesseract") and shutil.which("pdftoppm"):
            with tempfile.TemporaryDirectory(prefix="dhara-ocr-") as temp_dir:
                prefix = Path(temp_dir) / "page"
                subprocess.run(["pdftoppm", "-jpeg", "-r", "200", str(path), str(prefix)], capture_output=True, timeout=180, check=False)
                pages = sorted(Path(temp_dir).glob("page-*.jpg"))
                combined_text: list[str] = []
                combined_spans: list[WordConfidence] = []
                offset = 0
                for page in pages:
                    page_text, page_spans = _run_tesseract(page, language)
                    combined_spans.extend((start + offset, end + offset, confidence) for start, end, confidence in page_spans)
                    combined_text.append(page_text)
                    offset += len(page_text) + 1  # +1 for the "\n" joiner below
                return "\n".join(combined_text).strip(), "Tesseract OCR", combined_spans
        return text, "OCR unavailable", []

    if shutil.which("tesseract"):
        text, spans = _run_tesseract(path, language)
        return text, "Tesseract OCR", spans
    return "", "OCR unavailable", []


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


# Fields expected to contain a digit; a "match" with none is almost always an OCR/regex
# misfire (e.g. the label matched but swallowed the next line's unrelated text) and should
# score lower even though the pattern technically matched.
_NUMBER_LIKE_LABELS = {"Survey number", "Khasra number", "Khata number", "Mutation reference"}
_INDIC_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")


def _word_confidence(word_confidences: list[WordConfidence], start: int, end: int) -> float | None:
    overlapping = [confidence for word_start, word_end, confidence in word_confidences if word_start < end and word_end > start]
    return sum(overlapping) / len(overlapping) if overlapping else None


def _match_quality(label: str, value: str) -> float:
    """A 0-1 multiplier scoring whether the captured value actually looks like this field,
    independent of how confidently the underlying characters were recognized - a clean OCR
    read of the wrong text is still a bad extraction."""
    quality = 1.0
    if len(value.strip()) < 2:
        quality *= 0.5
    if label in _NUMBER_LIKE_LABELS and not re.search(r"[0-9०-९]", value):
        quality *= 0.55
    elif label == "Plot area" and not re.search(r"\d", value.translate(_INDIC_DIGITS)):
        quality *= 0.55
    return quality


def extract_fields(text: str, district: str, word_confidences: list[WordConfidence] | None = None, engine: str = "") -> list[dict]:
    word_confidences = word_confidences or []
    # No recognized-word confidences to draw on: an un-OCR'd PDF text layer is closer to
    # ground truth than a guess, so it starts high; anything else genuinely doesn't know.
    base_without_words = 97.0 if engine == "PDF text layer" else 65.0
    compact = re.sub(r"[ \t]+", " ", text)
    fields: list[dict] = []
    for label, patterns in FIELD_RULES:
        match = None
        for pattern in patterns:
            match = re.search(pattern, compact, flags=re.IGNORECASE)
            if match:
                break
        if match:
            value = match.group(1).strip(" .:-")
            base = _word_confidence(word_confidences, *match.span(1))
            if base is None:
                base = base_without_words
            confidence = round(max(0.0, min(100.0, base * _match_quality(label, value))), 1)
            fields.append({"label": label, "value": value, "original": match.group(0).strip(), "confidence": confidence, "valid": True})
        elif label == "District" and district != "Unassigned":
            fields.append({"label": label, "value": district, "original": "Upload metadata", "confidence": 100.0, "valid": True})
        else:
            fields.append({"label": label, "value": "", "original": "Not detected", "confidence": 0.0, "valid": False})
    return fields
