"""
Real-image integration test for the identity verification pipeline.

Tests the uploaded Georgia Driver's License image using actual EasyOCR —
no hardcoded answers, no mocked OCR. The pipeline must detect name, DOB,
and document type purely from what it reads off the card.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

# Make sure the workspace root is on the path so identity_service is importable.
sys.path.insert(0, str(Path(__file__).parent))

from identity_service.pipeline import verify_image_payload

IMAGE_PATH = Path(
    "/Users/instawork/.cursor/projects/"
    "Users-instawork-Desktop-untitled-folder-3/assets/"
    "image-296ec9ef-c3d5-4647-84f2-92ae66f51a40.png"
)

# Profile that matches the Georgia DL shown in the image.
# The pipeline must verify these independently by reading the card.
PROFILE = {
    "legalFirstName": "Shayla",
    "legalMiddleName": "Shenice",
    "legalLastName": "Boyd",
    "dateOfBirth": "1998-05-07",
    "addressLine1": "2303 Charleston Pl",
    "city": "Dunwoody",
    "state": "GA",
    "zip": "30338",
}


def load_image_as_data_url(path: Path) -> str:
    raw = path.read_bytes()
    b64 = base64.b64encode(raw).decode("ascii")
    return f"data:image/png;base64,{b64}"


def run_test() -> None:
    print("=" * 70)
    print("REAL-IMAGE PIPELINE TEST  —  Georgia Driver's License")
    print("=" * 70)

    if not IMAGE_PATH.exists():
        print(f"ERROR: Image not found at {IMAGE_PATH}")
        sys.exit(1)

    print(f"Image: {IMAGE_PATH.name}  ({IMAGE_PATH.stat().st_size:,} bytes)")
    print("Running OCR and analysis (first run initialises EasyOCR — may take ~30s)...\n")

    data_url = load_image_as_data_url(IMAGE_PATH)

    payload = {
        "requestId": "test-georgia-dl-real",
        "imageBase64": data_url,
        "selectedDocumentType": "drivers-license",
        "documentSide": "front",
        "profile": PROFILE,
    }

    result = verify_image_payload(payload)
    analysis = result["analysis"]
    fields = analysis.get("extractedFields", {})
    validation = analysis.get("validationResults", {})
    flags = analysis.get("flags", [])
    quality = analysis.get("imageQuality", {})

    # ── Pretty-print raw result ──────────────────────────────────────────────
    print("── RAW OCR RESULT ──────────────────────────────────────────────────")
    print(json.dumps(result, indent=2, default=str))
    print()

    # ── Assertions ──────────────────────────────────────────────────────────
    print("── ASSERTION CHECKS ────────────────────────────────────────────────")
    passes = 0
    failures = 0

    def check(label: str, condition: bool, expected: str = "", got: str = "") -> None:
        nonlocal passes, failures
        if condition:
            print(f"  PASS  {label}")
            passes += 1
        else:
            detail = f"  (expected: {expected!r}, got: {got!r})" if expected or got else ""
            print(f"  FAIL  {label}{detail}")
            failures += 1

    # Document type
    detected_type = analysis.get("detectedDocumentType", "")
    check(
        "Document type detected as drivers-license",
        detected_type == "drivers-license",
        "drivers-license",
        detected_type,
    )
    check("Document detected flag is True", analysis.get("documentDetected") is True)

    # Name extraction — must come from OCR, not profile
    first = fields.get("first_name", "")
    last = fields.get("last_name", "")
    check(
        f"First name extracted (got: {first!r})",
        first.upper() == "SHAYLA",
        "SHAYLA",
        first,
    )
    check(
        f"Last name extracted (got: {last!r})",
        last.upper() == "BOYD",
        "BOYD",
        last,
    )

    # DOB extraction
    dob = fields.get("date_of_birth", "")
    check(
        f"DOB extracted (got: {dob!r})",
        dob == "1998-05-07",
        "1998-05-07",
        dob,
    )

    # Validation matches
    name_status = validation.get("nameMatch", {}).get("status", "")
    dob_status = validation.get("dobMatch", {}).get("status", "")
    check(f"Name match status (got: {name_status!r})", name_status == "MATCH", "MATCH", name_status)
    check(f"DOB match status (got: {dob_status!r})", dob_status == "MATCH", "MATCH", dob_status)

    # Expiration — expires 05/07/2032, should be VALID as of May 2026
    exp_status = validation.get("expirationStatus", "")
    check(
        f"Expiration status (got: {exp_status!r})",
        exp_status == "VALID",
        "VALID",
        exp_status,
    )

    # No HALT on a matching, valid document
    next_action = analysis.get("nextAction", "")
    compliance = analysis.get("complianceEligibility", False)
    check(
        f"nextAction is CONTINUE (got: {next_action!r})",
        next_action == "CONTINUE",
        "CONTINUE",
        next_action,
    )
    check(
        f"complianceEligibility is True (got: {compliance!r})",
        compliance is True,
    )

    # Image quality sanity (image is sharp, should not flag as low-quality)
    flag_codes = [f["code"] for f in flags]
    check(
        "No IMAGE_QUALITY_LOW flag on a clear photograph",
        "IMAGE_QUALITY_LOW" not in flag_codes,
    )

    print()
    print(f"Result: {passes} passed, {failures} failed")
    print()
    if failures:
        print("Extracted fields:")
        for k, v in fields.items():
            print(f"  {k}: {v!r}")
        print()
        print("Flags:")
        for flag in flags:
            print(f"  [{flag['severity']}] {flag['code']}: {flag.get('message', '')}")
        print()
        print("Image quality metrics:", quality.get("metrics", {}))
        sys.exit(1)
    else:
        print("All checks passed — pipeline correctly identified the Georgia DL")
        print(f"  Name    : {first} {fields.get('middle_name', '')} {last}".strip())
        print(f"  DOB     : {dob}")
        print(f"  Doc type: {detected_type}")
        exp = fields.get("expiration_date", "not extracted")
        print(f"  Expires : {exp}")


if __name__ == "__main__":
    run_test()
