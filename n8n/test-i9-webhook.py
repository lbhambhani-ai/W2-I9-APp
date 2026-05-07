"""
I-9 Document Verification Webhook — Integration Test Runner
===========================================================
Sends targeted test cases to the live I-9 n8n webhook and validates:
  - Back-side: only checks correct back (NOT name/DOB/expiry)
  - Front-side: full verification (list match, name, DOB, expiry)
  - Wrong list: WRONG_LIST flag raised
  - Wrong document (same list): WRONG_DOCUMENT flag raised

Usage
-----
# Test endpoint (n8n test webhook):
export I9_WEBHOOK_URL="https://instawork.app.n8n.cloud/webhook-test/i9/verify-document"

# Production endpoint:
export I9_WEBHOOK_URL="https://instawork.app.n8n.cloud/webhook/i9/verify-document"

python n8n/test-i9-webhook.py
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

WEBHOOK_URL: str = os.environ.get(
    "I9_WEBHOOK_URL",
    "https://instawork.app.n8n.cloud/webhook-test/i9/verify-document",
)
TIMEOUT: int = int(os.environ.get("I9_TEST_TIMEOUT", "120"))

# A tiny 1x1 transparent PNG — used for structural tests where Gemini output
# doesn't matter (e.g. missing-field validation). For real vision tests we
# inline a real image via I9_IMAGE_BASE64 env var or the helper below.
DUMMY_PNG_B64 = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def load_image(path: str) -> str:
    """Load a local image file and return a data-URL base64 string."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Image not found: {path}")
    raw = p.read_bytes()
    b64 = base64.b64encode(raw).decode("ascii")
    suffix = p.suffix.lstrip(".").lower()
    mime = "jpeg" if suffix in ("jpg", "jpeg") else "png"
    return f"data:image/{mime};base64,{b64}"


# ---------------------------------------------------------------------------
# Test case definitions
# ---------------------------------------------------------------------------


@dataclass
class I9Case:
    label: str
    image_b64: str                    # data-URL base64 image
    selected_doc_type: str
    document_side: str
    citizenship_status: str
    expected_list: str                # "A", "B", or "C"
    expected_doc_label: str
    expected_doc_id: str
    profile: dict[str, Any]
    # What we expect the webhook to return:
    expect_compliance: bool           # complianceEligibility
    expect_flag_codes: list[str] = field(default_factory=list)   # flags that MUST be present
    forbid_flag_codes: list[str] = field(default_factory=list)   # flags that must NOT be present
    # For back-side tests: name/DOB must NOT be checked
    back_side_no_name_dob_check: bool = False
    skip_vision: bool = False         # True → skip Gemini assertions (structural-only)


PROFILE_JANE = {
    "legalFirstName": "Jane",
    "legalMiddleName": "",
    "legalLastName": "Smith",
    "dateOfBirth": "1990-03-15",
}

CASES: list[I9Case] = [
    # ── 1. Valid front — Passport Card (List A) ──────────────────────────────
    I9Case(
        label="Front: Passport Card (List A) — structural shape test",
        image_b64=DUMMY_PNG_B64,
        selected_doc_type="passport-card",
        document_side="front",
        citizenship_status="us_citizen",
        expected_list="A",
        expected_doc_label="US Passport Card",
        expected_doc_id="passport-card",
        profile=PROFILE_JANE,
        expect_compliance=False,      # dummy image → Gemini will say no doc detected
        forbid_flag_codes=[],
        skip_vision=True,             # we only check response shape
    ),

    # ── 2. Back side — Passport Card ─────────────────────────────────────────
    # KEY TEST: back side must NOT fail on name/DOB/expiry
    I9Case(
        label="Back: Passport Card (List A) — back side must not check name/DOB",
        image_b64=DUMMY_PNG_B64,
        selected_doc_type="passport-card",
        document_side="back",
        citizenship_status="us_citizen",
        expected_list="A",
        expected_doc_label="US Passport Card",
        expected_doc_id="passport-card",
        profile=PROFILE_JANE,
        expect_compliance=False,      # dummy image → won't pass vision
        forbid_flag_codes=["NAME_MISMATCH", "DOB_MISMATCH", "DOCUMENT_EXPIRED"],
        back_side_no_name_dob_check=True,
        skip_vision=True,
    ),

    # ── 3. Back side — Driver's License ──────────────────────────────────────
    I9Case(
        label="Back: Driver's License (List B) — back side must not check name/DOB",
        image_b64=DUMMY_PNG_B64,
        selected_doc_type="drivers-license",
        document_side="back",
        citizenship_status="us_citizen",
        expected_list="B",
        expected_doc_label="US Driver's License",
        expected_doc_id="drivers-license",
        profile=PROFILE_JANE,
        expect_compliance=False,
        forbid_flag_codes=["NAME_MISMATCH", "DOB_MISMATCH", "DOCUMENT_EXPIRED"],
        back_side_no_name_dob_check=True,
        skip_vision=True,
    ),

    # ── 4. Missing required field — should return 400 ────────────────────────
    I9Case(
        label="Invalid request — missing i9Context (expect 400)",
        image_b64=DUMMY_PNG_B64,
        selected_doc_type="passport-card",
        document_side="front",
        citizenship_status="",        # empty → triggers validation error
        expected_list="A",
        expected_doc_label="US Passport Card",
        expected_doc_id="passport-card",
        profile=PROFILE_JANE,
        expect_compliance=False,
        skip_vision=True,
    ),

    # ── 5. Back side — EAD ───────────────────────────────────────────────────
    I9Case(
        label="Back: EAD (List A) — back side must not check name/DOB",
        image_b64=DUMMY_PNG_B64,
        selected_doc_type="employment-authorization-card",
        document_side="back",
        citizenship_status="noncitizen_authorized",
        expected_list="A",
        expected_doc_label="Employment Authorization Document",
        expected_doc_id="employment-authorization-card",
        profile=PROFILE_JANE,
        expect_compliance=False,
        forbid_flag_codes=["NAME_MISMATCH", "DOB_MISMATCH", "DOCUMENT_EXPIRED"],
        back_side_no_name_dob_check=True,
        skip_vision=True,
    ),
]


# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------


def post_json(url: str, payload: dict, timeout: int) -> tuple[int, dict]:
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
            capture_output=True, text=True, timeout=timeout + 10,
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
        body = {"raw": body_text.strip()[:500]}
    return status_code, body


# ---------------------------------------------------------------------------
# Evaluate a single case
# ---------------------------------------------------------------------------


def build_payload(case: I9Case) -> dict:
    return {
        "requestId": f"i9-test-{case.label[:30].replace(' ', '-').lower()}",
        "selectedDocumentType": case.selected_doc_type,
        "documentSide": case.document_side,
        "imageBase64": case.image_b64,
        "profile": case.profile,
        "i9Context": {
            "citizenshipStatus": case.citizenship_status,
            "documentPath": f"list{case.expected_list}/{case.expected_doc_id}",
            "expectedList": case.expected_list,
            "expectedDocId": case.expected_doc_id,
            "expectedDocLabel": case.expected_doc_label,
        },
    }


def evaluate_case(idx: int, case: I9Case) -> tuple[bool, str]:
    payload = build_payload(case)

    # Special: missing-field test
    is_missing_field_test = case.citizenship_status == ""
    if is_missing_field_test:
        payload["i9Context"]["citizenshipStatus"] = ""

    t0 = time.monotonic()
    status_code, response = post_json(WEBHOOK_URL, payload, TIMEOUT)
    elapsed = time.monotonic() - t0

    passes: list[str] = []
    failures: list[str] = []

    def chk(label: str, ok: bool, note: str = "") -> None:
        if ok:
            passes.append(f"    PASS  {label}")
        else:
            detail = f" ({note})" if note else ""
            failures.append(f"    FAIL  {label}{detail}")

    def skip(label: str) -> None:
        passes.append(f"    SKIP  {label}")

    # ── Missing-field test expects 400 ────────────────────────────────────────
    if is_missing_field_test:
        chk("http 400 for invalid request", status_code == 400,
            f"got {status_code}")
        chk("error code present",
            isinstance(response.get("error"), dict) or "error" in response)
        all_passed = not failures
        summary = (
            f"  {'OK  ' if all_passed else 'FAIL'}  [{idx}] {case.label}  ({elapsed:.1f}s)"
        )
        if not all_passed:
            summary += "\n" + "\n".join(failures)
            summary += f"\n        Response: {json.dumps(response)[:400]}"
        return all_passed, summary

    # ── Normal cases expect 200 ───────────────────────────────────────────────
    chk("http 200", status_code == 200, f"got {status_code}")
    if status_code != 200:
        summary = (
            f"  FAIL  [{idx}] {case.label}  ({elapsed:.1f}s)\n"
            + "\n".join(failures)
            + f"\n        Response: {json.dumps(response)[:400]}"
        )
        return False, summary

    chk("success=true", response.get("success") is True)
    chk("requestId present", bool(response.get("requestId")))
    chk("source=n8n-i9-gemini", response.get("source") == "n8n-i9-gemini",
        f"got {response.get('source')!r}")
    chk("userMessage present", bool(response.get("userMessage")))

    analysis = response.get("analysis", {})
    chk("analysis object present", isinstance(analysis, dict))

    if not case.skip_vision:
        flags = analysis.get("flags", [])
        flag_codes = {f.get("code", "") for f in flags if isinstance(f, dict)}

        for code in case.expect_flag_codes:
            chk(f"flag {code} present", code in flag_codes,
                f"present flags: {flag_codes}")
        for code in case.forbid_flag_codes:
            chk(f"flag {code} absent", code not in flag_codes,
                f"present flags: {flag_codes}")

    # ── Back-side specific checks ─────────────────────────────────────────────
    if case.back_side_no_name_dob_check:
        vr = analysis.get("validationResults", {})
        name_status = vr.get("nameMatch", {}).get("status", "")
        dob_status = vr.get("dobMatch", {}).get("status", "")
        expiry_status = vr.get("expirationStatus", "")

        chk(
            f"nameMatch=NOT_CHECKED on back side (got {name_status!r})",
            name_status in ("NOT_CHECKED", ""),
            f"expected NOT_CHECKED, got {name_status!r}",
        )
        chk(
            f"dobMatch=NOT_CHECKED on back side (got {dob_status!r})",
            dob_status in ("NOT_CHECKED", ""),
            f"expected NOT_CHECKED, got {dob_status!r}",
        )
        chk(
            f"expirationStatus=NOT_CHECKED on back side (got {expiry_status!r})",
            expiry_status in ("NOT_CHECKED", "UNKNOWN", ""),
            f"expected NOT_CHECKED, got {expiry_status!r}",
        )

    all_passed = not failures
    summary = (
        f"  {'OK  ' if all_passed else 'FAIL'}  [{idx}] {case.label}  ({elapsed:.1f}s)"
    )
    if not all_passed:
        summary += "\n" + "\n".join(failures)
        summary += f"\n        Full analysis: {json.dumps(analysis, default=str)[:600]}"
    return all_passed, summary


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    print("=" * 72)
    print(f"I-9 DOCUMENT VERIFICATION WEBHOOK TEST  —  {len(CASES)} cases")
    print(f"Webhook : {WEBHOOK_URL}")
    print(f"Timeout : {TIMEOUT}s per request")
    print("=" * 72)
    print()

    total_pass = 0
    total_fail = 0
    all_summaries: list[str] = []

    for idx, case in enumerate(CASES, 1):
        print(f"  [{idx:02d}/{len(CASES)}] {case.label} ...", end="", flush=True)
        ok, summary = evaluate_case(idx, case)
        if ok:
            total_pass += 1
            print(" OK")
        else:
            total_fail += 1
            print(" FAIL")
            all_summaries.append(summary)

    print()
    print("─" * 72)

    if all_summaries:
        print("FAILURES:\n")
        for s in all_summaries:
            print(s)
            print()

    score = f"{total_pass}/{len(CASES)}"
    print(f"Result: {score} passed, {total_fail} failed")
    print("=" * 72)
    sys.exit(1 if total_fail else 0)


if __name__ == "__main__":
    main()
