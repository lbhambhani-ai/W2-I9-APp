"""
n8n Identity Verification Webhook — Integration Test Runner
============================================================
Sends each test case to the live n8n webhook, validates the response shape,
and prints a per-case pass/fail summary with a final score.

Usage
-----
# Set the webhook URL (copy from n8n after activating the workflow):
export N8N_WEBHOOK_URL="https://your-n8n-instance.example.com/webhook/identity/verify-document"

# Optional: change the timeout or image asset folder:
export N8N_TEST_TIMEOUT=120
export N8N_ASSETS_DIR="/Users/instawork/.cursor/projects/Users-instawork-Desktop-untitled-folder-3/assets"

python n8n/test-n8n-webhook.py
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

WEBHOOK_URL: str = os.environ.get(
    "N8N_WEBHOOK_URL",
    "http://localhost:5678/webhook/identity/verify-document",
)
TIMEOUT: int = int(os.environ.get("N8N_TEST_TIMEOUT", "120"))
ASSETS_DIR: Path = Path(
    os.environ.get(
        "N8N_ASSETS_DIR",
        "/Users/instawork/.cursor/projects/Users-instawork-Desktop-untitled-folder-3/assets",
    )
)

# ---------------------------------------------------------------------------
# Test Cases  (same dataset as test_batch_real_images.py)
# ---------------------------------------------------------------------------


@dataclass
class Case:
    label: str
    image_file: str
    doc_type: str
    doc_side: str
    profile: dict[str, Any]
    expected_first: str       # uppercase, e.g. "SHANTIKA"
    expected_last: str        # uppercase
    expected_dob: str         # YYYY-MM-DD or "" to skip DOB check
    expected_expiry_status: str = "VALID"
    expected_action: str = "CONTINUE"


CASES: list[Case] = [
    # 1. Georgia State ID – Shantika Shanae Anderson
    Case(
        label="Georgia State ID — Anderson",
        image_file="file_front_5c106e24-2473-4e26-8fd0-f8e9434cefe6-c54125cb-c06f-4a21-8e48-544aa6032524.png",
        doc_type="state-id",
        doc_side="front",
        profile={
            "legalFirstName": "Shantika",
            "legalMiddleName": "Shanae",
            "legalLastName": "Anderson",
            "dateOfBirth": "1989-09-28",
            "addressLine1": "3384 Mount Zion Rd Apt 1104",
            "city": "Stockbridge",
            "state": "GA",
            "zip": "30281",
        },
        expected_first="SHANTIKA",
        expected_last="ANDERSON",
        expected_dob="1989-09-28",
    ),
    # 2. EAD back (MRZ) – Akabueze Maureen Onyine
    Case(
        label="EAD Back MRZ — Akabueze",
        image_file="file_back_f3dc79af-aa50-4b1d-b0e6-08d6650217b8-1e972ab4-b653-4d1b-b44f-8b8dd5cb9fa8.png",
        doc_type="employment-authorization-card",
        doc_side="back",
        profile={
            "legalFirstName": "Maureen",
            "legalMiddleName": "Onyine",
            "legalLastName": "Akabueze",
            "dateOfBirth": "1996-11-28",
        },
        expected_first="MAUREEN",
        expected_last="AKABUEZE",
        expected_dob="",            # back-side MRZ may not yield DOB if glare
        expected_expiry_status="UNKNOWN",
    ),
    # 3. US Passport – Chiara Losa Ahio
    Case(
        label="US Passport — Ahio / Chiara Losa",
        image_file="file_front_5479c41f-6c8f-46f4-a7b7-20b100d9a744-c819c864-d0d4-4503-bc97-93aeb2d1aea4.png",
        doc_type="passport",
        doc_side="front",
        profile={
            "legalFirstName": "Chiara",
            "legalMiddleName": "Losa",
            "legalLastName": "Ahio",
            "dateOfBirth": "2008-02-24",
        },
        expected_first="CHIARA",
        expected_last="AHIO",
        expected_dob="2008-02-24",
    ),
    # 4. US Passport – Muhammad Abdullah Abbasi
    Case(
        label="US Passport — Abbasi / Muhammad Abdullah",
        image_file="file_front_06e48a77-0e34-477a-82f6-4fe1e6d78067-ac6d933c-bd8b-4d3f-847e-03d036968494.png",
        doc_type="passport",
        doc_side="front",
        profile={
            "legalFirstName": "Muhammad",
            "legalMiddleName": "Abdullah",
            "legalLastName": "Abbasi",
            "dateOfBirth": "2004-07-09",
        },
        expected_first="MUHAMMAD",
        expected_last="ABBASI",
        expected_dob="2004-07-09",
    ),
    # 5. EAD front – Akabueze Maureen Onyine
    Case(
        label="EAD Front — Akabueze / Maureen",
        image_file="file_front_220f9111-6dd9-423c-a0b7-890abde2edeb-b602b1a4-82d6-48c3-8c8f-73d66a2be597.png",
        doc_type="employment-authorization-card",
        doc_side="front",
        profile={
            "legalFirstName": "Maureen",
            "legalMiddleName": "Onyine",
            "legalLastName": "Akabueze",
            "dateOfBirth": "1996-11-28",
        },
        expected_first="MAUREEN",
        expected_last="AKABUEZE",
        expected_dob="1996-11-28",
    ),
    # 6. US Passport – Henry Chukwuemeka Benjamin
    Case(
        label="US Passport — Benjamin / Henry Chukwuemeka",
        image_file="file_front_22c00e13-3833-4129-a106-f5617c4810a4-0b7294b9-2780-4585-b85b-3ac891ea7322.png",
        doc_type="passport",
        doc_side="front",
        profile={
            "legalFirstName": "Henry",
            "legalMiddleName": "Chukwuemeka",
            "legalLastName": "Benjamin",
            "dateOfBirth": "2006-11-20",
        },
        expected_first="HENRY",
        expected_last="BENJAMIN",
        expected_dob="2006-11-20",
    ),
    # 7. Florida DL – Tyrell Jaydon Brooks
    Case(
        label="Florida DL — Brooks / Tyrell Jaydon",
        image_file="file_front_9e1803b3-e3ef-4023-a40c-53237510e261-b2d5ec6c-ba5e-469e-a946-9c4779f98f87.png",
        doc_type="drivers-license",
        doc_side="front",
        profile={
            "legalFirstName": "Tyrell",
            "legalMiddleName": "Jaydon",
            "legalLastName": "Brooks",
            "dateOfBirth": "2004-09-22",
            "addressLine1": "1338 Lake Bonny Dr W",
            "city": "Lakeland",
            "state": "FL",
            "zip": "33801",
        },
        expected_first="TYRELL",
        expected_last="BROOKS",
        expected_dob="2004-09-22",
    ),
    # 8. Massachusetts DL – Amir Khikmatovich Abdujabbarov
    Case(
        label="Massachusetts DL — Abdujabbarov / Amir",
        image_file="file_front_5e654dbb-feb5-4e83-8790-c67ebfd8cc8b-c3d18b47-8a3e-486b-8157-b8bc4290a8a5.png",
        doc_type="drivers-license",
        doc_side="front",
        profile={
            "legalFirstName": "Amir",
            "legalMiddleName": "Khikmatovich",
            "legalLastName": "Abdujabbarov",
            "dateOfBirth": "1996-01-29",
            "addressLine1": "490 Union St Apt 25",
            "city": "Rockland",
            "state": "MA",
            "zip": "02370",
        },
        expected_first="AMIR",
        expected_last="ABDUJABBAROV",
        expected_dob="1996-01-29",
    ),
    # 9. Alabama DL – Jean Creamer Allen
    Case(
        label="Alabama DL — Allen / Jean Creamer",
        image_file="file_front_059d0a2f-f282-404a-8b24-7319aa64bfa3-45eafced-ebcb-4236-905d-5f80af5b7175.png",
        doc_type="drivers-license",
        doc_side="front",
        profile={
            "legalFirstName": "Jean",
            "legalMiddleName": "Creamer",
            "legalLastName": "Allen",
            "dateOfBirth": "1945-07-01",
            "addressLine1": "4140 Hillsboro Dr",
            "city": "Tuscaloosa",
            "state": "AL",
            "zip": "35404",
        },
        expected_first="JEAN",
        expected_last="ALLEN",
        expected_dob="1945-07-01",
    ),
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def load_image_as_data_url(path: Path) -> str:
    raw = path.read_bytes()
    b64 = base64.b64encode(raw).decode("ascii")
    suffix = path.suffix.lstrip(".").lower()
    mime = "jpeg" if suffix in ("jpg", "jpeg") else "png"
    return f"data:image/{mime};base64,{b64}"


def post_json(url: str, payload: dict, timeout: int) -> tuple[int, dict]:
    """POST payload as JSON using curl so large base64 bodies are handled correctly."""
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, encoding="utf-8"
    ) as tmp:
        json.dump(payload, tmp)
        tmp_path = tmp.name

    try:
        result = subprocess.run(
            [
                "curl", "-s", "-w", "\n__STATUS__%{http_code}",
                "-X", "POST", url,
                "-H", "Content-Type: application/json",
                "--data-binary", f"@{tmp_path}",
                "--max-time", str(timeout),
                "--connect-timeout", "30",
            ],
            capture_output=True,
            text=True,
            timeout=timeout + 10,
        )
    except subprocess.TimeoutExpired:
        return 0, {"error": "curl timed out"}
    except Exception as exc:
        return 0, {"error": str(exc)}
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    output = result.stdout
    status_code = 0
    body_text = output

    if "\n__STATUS__" in output:
        body_text, status_str = output.rsplit("\n__STATUS__", 1)
        try:
            status_code = int(status_str.strip())
        except ValueError:
            pass

    try:
        body = json.loads(body_text.strip())
    except Exception:
        body = {"error": f"Non-JSON response: {body_text.strip()[:300]}"}

    return status_code, body


# ---------------------------------------------------------------------------
# Core assertion logic
# ---------------------------------------------------------------------------


def evaluate_case(idx: int, case: Case) -> tuple[bool, str, dict]:
    image_path = ASSETS_DIR / case.image_file
    if not image_path.exists():
        msg = f"  SKIP  [{idx}] {case.label}\n        Image not found: {image_path}"
        return False, msg, {}

    payload = {
        "requestId": f"n8n-test-{idx:02d}",
        "selectedDocumentType": case.doc_type,
        "documentSide": case.doc_side,
        "imageBase64": load_image_as_data_url(image_path),
        "profile": case.profile,
    }

    t0 = time.monotonic()
    status_code, response = post_json(WEBHOOK_URL, payload, TIMEOUT)
    elapsed = time.monotonic() - t0

    passes: list[str] = []
    failures: list[str] = []

    def chk(label: str, ok: bool, expected: str = "", got: str = "") -> None:
        if ok:
            passes.append(f"    PASS  {label}")
        else:
            detail = f" (expected={expected!r} got={got!r})" if expected or got else ""
            failures.append(f"    FAIL  {label}{detail}")

    # HTTP layer
    chk("http 200", status_code == 200, "200", str(status_code))
    if status_code != 200:
        msg = f"  FAIL  [{idx}] {case.label}  ({elapsed:.1f}s)\n"
        msg += "\n".join(failures)
        msg += f"\n        Response: {json.dumps(response, default=str)[:500]}"
        return False, msg, response

    # Wrapper shape
    chk("success=true", response.get("success") is True)
    chk("requestId preserved", response.get("requestId") == payload["requestId"],
        payload["requestId"], str(response.get("requestId")))
    chk("source=n8n-chatgpt-vision",
        response.get("source") in ("n8n-chatgpt-vision", "n8n-chatgpt-vision-v2"),
        "n8n-chatgpt-vision", str(response.get("source")))
    chk("googleDriveFileId present",
        bool(response.get("googleDriveFileId")))

    analysis = response.get("analysis", {})
    fields = analysis.get("extractedFields", {})
    val = analysis.get("validationResults", {})
    # v2 puts booleanChecks inside analysis AND a flat booleanSummary at top level
    bool_checks = response.get("booleanSummary") or analysis.get("booleanChecks", {})
    flags = analysis.get("flags", [])
    flag_codes = [f.get("code", "") for f in flags if isinstance(f, dict)]

    # Document detection
    chk("documentDetected", analysis.get("documentDetected") is True)
    detected_type = analysis.get("detectedDocumentType", "")
    chk(f"detectedDocumentType={detected_type!r}",
        detected_type == case.doc_type, case.doc_type, detected_type)
    detected_side = analysis.get("detectedSide", "")
    chk(f"detectedSide={detected_side!r}",
        detected_side == case.doc_side, case.doc_side, detected_side)

    # Extracted fields
    first = (fields.get("first_name") or "").upper()
    last = (fields.get("last_name") or "").upper()
    dob = fields.get("date_of_birth") or ""

    chk(f"first_name={first!r}", first == case.expected_first,
        case.expected_first, first)
    chk(f"last_name={last!r}", last == case.expected_last,
        case.expected_last, last)
    if case.expected_dob:
        chk(f"date_of_birth={dob!r}", dob == case.expected_dob,
            case.expected_dob, dob)
    else:
        passes.append("    SKIP  date_of_birth (back-side)")

    # Validation results — v2 exposes nameCompare/dobCompare/expiryCheck at top level too
    name_compare  = response.get("nameCompare")  or analysis.get("nameCompare", "")
    dob_compare   = response.get("dobCompare")   or analysis.get("dobCompare", "")
    expiry_check  = response.get("expiryCheck")  or analysis.get("expiryCheck", "")
    name_status = val.get("nameMatch", {}).get("status", "") or name_compare
    dob_status  = val.get("dobMatch",  {}).get("status", "") or dob_compare
    exp_status  = val.get("expirationStatus", "") or expiry_check
    next_action = analysis.get("nextAction", "")

    chk(f"nameMatch={name_status!r}", name_status in ("MATCH", "PARTIAL_MATCH"),
        "MATCH|PARTIAL_MATCH", name_status)
    if case.expected_dob:
        chk(f"dobMatch={dob_status!r}", dob_status == "MATCH", "MATCH", dob_status)
    else:
        passes.append("    SKIP  dobMatch (back-side)")
    chk(f"expirationStatus={exp_status!r}",
        exp_status == case.expected_expiry_status,
        case.expected_expiry_status, exp_status)
    chk(f"nextAction={next_action!r}",
        next_action == case.expected_action,
        case.expected_action, next_action)
    chk("canContinue=true", bool_checks.get("canContinue") is True)
    chk("no IMAGE_QUALITY_LOW flag", "IMAGE_QUALITY_LOW" not in flag_codes)
    chk("no SIDE_MISMATCH flag", "SIDE_MISMATCH" not in flag_codes)
    chk("userMessage present", bool(analysis.get("userMessage")))

    all_passed = not failures
    summary = f"  {'OK  ' if all_passed else 'FAIL'}  [{idx}] {case.label}  ({elapsed:.1f}s)"
    if not all_passed:
        summary += "\n" + "\n".join(failures)
        summary += f"\n        Flags: {flag_codes}"
        ef = {k: v for k, v in fields.items() if v}
        summary += f"\n        Extracted: {json.dumps(ef, default=str)}"
        # Print reviewReason which contains our debug dump
        review_reason = response.get("analysis", {}).get("reviewReason") or response.get("reviewReason", "")
        if review_reason:
            summary += f"\n        DEBUG: {review_reason[:600]}"
    return all_passed, summary, response


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    print("=" * 72)
    print(f"N8N IDENTITY VERIFICATION WEBHOOK TEST  —  {len(CASES)} cases")
    print(f"Webhook : {WEBHOOK_URL}")
    print(f"Timeout : {TIMEOUT}s per request")
    print(f"Assets  : {ASSETS_DIR}")
    print("=" * 72)

    total_pass = 0
    total_fail = 0
    failures: list[str] = []

    for idx, case in enumerate(CASES, 1):
        print(f"  [{idx:02d}/{len(CASES)}] {case.label} ...", end="", flush=True)
        ok, summary, response = evaluate_case(idx, case)
        if ok:
            total_pass += 1
            print(" OK")
        else:
            total_fail += 1
            print(" FAIL")
            failures.append(summary)

    print()
    print("─" * 72)

    if failures:
        print("FAILURES:\n")
        for f in failures:
            print(f)
            print()

    print(f"Result: {total_pass}/{len(CASES)} passed, {total_fail} failed")
    print("=" * 72)
    sys.exit(1 if total_fail else 0)


if __name__ == "__main__":
    main()
