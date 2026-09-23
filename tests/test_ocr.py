import subprocess
import sys
from pathlib import Path

from backend.ocr import extract_fields

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"


def test_extract_fields_reuses_an_exact_confirmed_correction():
    text = "Khasra number: 88/8\nDistrict: Test"
    baseline = extract_fields(text, "Test")
    assert next(field for field in baseline if field["label"] == "Khasra number")["value"] == "88/8"

    corrections = {("Khasra number", "88/8"): "88/1"}
    reused = extract_fields(text, "Test", corrections=corrections)
    khasra = next(field for field in reused if field["label"] == "Khasra number")
    assert khasra["value"] == "88/1"
    assert "reused a confirmed correction" in khasra["original"]


def test_extract_fields_reuses_a_near_match_correction():
    # A different document, same recurring OCR misread pattern with one digit off from the
    # exact raw string that was corrected before - the "near-match" half of the reuse lookup.
    corrections = {("Khasra number", "88/8"): "88/1"}
    near_text = "Khasra number: 88/9\nDistrict: Test"
    near = extract_fields(near_text, "Test", corrections=corrections)
    khasra = next(field for field in near if field["label"] == "Khasra number")
    assert khasra["value"] == "88/1"


def test_extract_fields_does_not_reuse_an_unrelated_correction():
    # A khasra number nothing like the corrected raw string should extract normally, not be
    # dragged toward an unrelated confirmed correction.
    corrections = {("Khasra number", "88/8"): "88/1"}
    text = "Khasra number: 41/2\nDistrict: Test"
    result = extract_fields(text, "Test", corrections=corrections)
    khasra = next(field for field in result if field["label"] == "Khasra number")
    assert khasra["value"] == "41/2"


def test_mixed_hindi_english_fixture_extracts_bilingual_fields():
    # A realistic bilingual record (Hindi and English labels on alternating lines) - not the
    # single-language, one-field-per-line fixture the UI smoke test otherwise only exercises.
    text = (FIXTURES / "sample-land-record-mixed-hindi-english.txt").read_text(encoding="utf-8")
    fields = {field["label"]: field for field in extract_fields(text, "Prayagraj")}
    assert fields["Landowner name"]["value"] == "Ramesh Chandra Yadav"
    assert fields["Khasra number"]["value"] == "41/2"
    assert fields["District"]["value"] == "Prayagraj"
    # Deliberately absent from this fixture - a realistic partial extraction should say so
    # honestly (not detected) rather than fabricate a value for a field that isn't there.
    assert fields["Registration information"]["valid"] is False


def test_devanagari_khasra_fixture_extracts_the_raw_digits_verbatim():
    # The exact demo scenario for the correction-reuse loop: a Khasra number written in
    # Devanagari numerals, unlabeled by a colon (a realistic OCR/formatting variant).
    text = (FIXTURES / "sample-land-record-devanagari-khasra.txt").read_text(encoding="utf-8")
    fields = {field["label"]: field for field in extract_fields(text, "Varanasi")}
    # No normalization happens at extraction time - this raw string is exactly what a
    # FieldCorrection's predicted_value would hold, and exactly what the reuse lookup above
    # is keyed on, so correcting it once on this document lets a second, similarly garbled
    # document resolve automatically.
    assert fields["Khasra number"]["value"] == "८८/१"
    assert fields["Mutation reference"]["valid"] is False


def test_synthesize_degraded_scan_produces_a_usable_image(tmp_path):
    output = tmp_path / "degraded.jpg"
    result = subprocess.run(
        [sys.executable, "scripts/synthesize_degraded_scan.py", "tests/fixtures/sample-land-record-devanagari-khasra.txt", str(output)],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    assert result.returncode == 0, result.stderr
    assert output.exists() and output.stat().st_size > 1_000
