"""
Real-image integration test — Florida Driver's License
Tyrell Jaydon Brooks, DOB 09/22/2004
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from identity_service.pipeline import verify_image_payload

IMAGE_PATH = Path(
    "/Users/instawork/.cursor/projects/"
    "Users-instawork-Desktop-untitled-folder-3/assets/"
    "image-ee753a59-8232-4a68-a402-417d606d82a4.png"
)

PROFILE = {
    "legalFirstName": "Tyrell",
    "legalMiddleName": "Jaydon",
    "legalLastName": "Brooks",
    "dateOfBirth": "2004-09-22",
    "addressLine1": "1338 Lake Bonny Dr W",
    "city": "Lakeland",
    "state": "FL",
    "zip": "33801",
}


def load_image_as_data_url(path: Path) -> str:
    raw = path.read_bytes()
    b64 = base64.b64encode(raw).decode("ascii")
    return f"data:image/png;base64,{b64}"


def run_test() -> None:
    print("=" * 70)
    print("REAL-IMAGE PIPELINE TEST  —  Florida Driver's License")
    print("=" * 70)

    if not IMAGE_PATH.exists():
        print(f"ERROR: Image not found at {IMAGE_PATH}")
        sys.exit(1)

    print(f"Image : {IMAGE_PATH.name}  ({IMAGE_PATH.stat().st_size:,} bytes)")
    print("Running OCR and analysis (EasyOCR already warm)...\n")

    payload = {
        "requestId": "test-florida-dl-real",
        "imageBase64": load_image_as_data_url(IMAGE_PATH),
        "selectedDocumentType": "drivers-license",
        "documentSide": "front",
        "profile": PROFILE,
    }

    result = verify_image_payload(payload)
    analysis = result["analysis"]
    fields   = analysis.get("extractedFields", {})
    val      = analysis.get("validationResults", {})
    flags    = analysis.get("flags", [])
    quality  = analysis.get("imageQuality", {})

    print("── RAW OCR RESULT ──────────────────────────────────────────────────")
    print(json.dumps(result, indent=2, default=str))
    print()

    print("── ASSERTION CHECKS ────────────────────────────────────────────────")
    passes = failures = 0

    def check(label: str, condition: bool, expected: str = "", got: str = "") -> None:
        nonlocal passes, failures
        if condition:
            print(f"  PASS  {label}")
            passes += 1
        else:
            detail = f"  (expected: {expected!r}, got: {got!r})" if expected or got else ""
            print(f"  FAIL  {label}{detail}")
            failures += 1

    detected_type = analysis.get("detectedDocumentType", "")
    check("Document type → drivers-license", detected_type == "drivers-license", "drivers-license", detected_type)
    check("documentDetected is True", analysis.get("documentDetected") is True)

    first = fields.get("first_name", "")
    last  = fields.get("last_name",  "")
    check(f"First name extracted (got: {first!r})", first.upper() == "TYRELL",  "TYRELL",  first)
    check(f"Last name extracted  (got: {last!r})",  last.upper()  == "BROOKS",  "BROOKS",  last)

    dob = fields.get("date_of_birth", "")
    check(f"DOB extracted (got: {dob!r})", dob == "2004-09-22", "2004-09-22", dob)

    name_status = val.get("nameMatch", {}).get("status", "")
    dob_status  = val.get("dobMatch",  {}).get("status", "")
    check(f"Name match → MATCH  (got: {name_status!r})", name_status == "MATCH", "MATCH", name_status)
    check(f"DOB  match → MATCH  (got: {dob_status!r})",  dob_status  == "MATCH", "MATCH", dob_status)

    exp_status  = val.get("expirationStatus", "")
    # Expires 09/22/2030; today is May 2026 — should be VALID
    check(f"Expiration → VALID  (got: {exp_status!r})", exp_status == "VALID", "VALID", exp_status)

    next_action  = analysis.get("nextAction", "")
    compliance   = analysis.get("complianceEligibility", False)
    check(f"nextAction → CONTINUE (got: {next_action!r})", next_action == "CONTINUE", "CONTINUE", next_action)
    check(f"complianceEligibility → True (got: {compliance!r})", compliance is True)

    flag_codes = [f["code"] for f in flags]
    check("No IMAGE_QUALITY_LOW flag", "IMAGE_QUALITY_LOW" not in flag_codes)

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
        print("All checks passed — pipeline correctly identified the Florida DL")
        mid = fields.get("middle_name", "")
        name_str = " ".join(p for p in [first, mid, last] if p)
        print(f"  Name    : {name_str}")
        print(f"  DOB     : {dob}")
        print(f"  Doc type: {detected_type}")
        print(f"  Expires : {fields.get('expiration_date', 'not extracted')}")


if __name__ == "__main__":
    run_test()
