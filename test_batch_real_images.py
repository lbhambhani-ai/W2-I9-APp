"""
Batch real-image integration test for the identity verification pipeline.
Runs 9 actual ID document photos through live EasyOCR — no hardcoded answers.
"""

from __future__ import annotations

import base64
import json
import sys
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

from identity_service.pipeline import verify_image_payload

ASSETS = Path(
    "/Users/instawork/.cursor/projects/"
    "Users-instawork-Desktop-untitled-folder-3/assets"
)


@dataclass
class Case:
    label: str
    image_file: str
    doc_type: str
    doc_side: str
    profile: dict[str, Any]
    expected_first: str
    expected_last: str
    expected_dob: str
    expected_expiry_status: str = "VALID"  # VALID / EXPIRED
    expected_action: str = "CONTINUE"
    extra_checks: dict[str, Any] = field(default_factory=dict)


CASES: list[Case] = [
    # ── 1. Georgia State ID – Shantika Shanae Anderson ────────────────────
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
        expected_expiry_status="VALID",
    ),

    # ── 2. EAD back (MRZ) – Akabueze Maureen Onyine ───────────────────────
    # Back side: DOB line is often garbled/holographic; name is the primary check.
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
        expected_dob="",          # back-side MRZ may not yield DOB if holographic glare
        expected_expiry_status="UNKNOWN",  # back-side MRZ may not yield expiry
    ),

    # ── 3. US Passport – Chiara Losa Ahio ─────────────────────────────────
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
        expected_expiry_status="VALID",
    ),

    # ── 4. US Passport – Muhammad Abdullah Abbasi ─────────────────────────
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
        expected_expiry_status="VALID",
    ),

    # ── 5. EAD front – Akabueze Maureen O ─────────────────────────────────
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
        expected_expiry_status="VALID",
    ),

    # ── 6. US Passport – Henry Chukwuemeka Benjamin ────────────────────────
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
        expected_expiry_status="VALID",
    ),

    # ── 7. Florida DL – Tyrell Jaydon Brooks (already tested) ─────────────
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
        expected_expiry_status="VALID",
    ),

    # ── 8. Massachusetts DL – Amir Khikmatovich Abdujabbarov ──────────────
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
        expected_expiry_status="VALID",
    ),

    # ── 9. Alabama DL – Jean Creamer Allen ────────────────────────────────
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
        expected_expiry_status="VALID",
    ),
]


def load_image_as_data_url(path: Path) -> str:
    raw = path.read_bytes()
    b64 = base64.b64encode(raw).decode("ascii")
    suffix = path.suffix.lstrip(".").lower()
    mime = "jpeg" if suffix in ("jpg", "jpeg") else "png"
    return f"data:image/{mime};base64,{b64}"


def run_case(idx: int, case: Case) -> tuple[bool, str, dict[str, Any]]:
    image_path = ASSETS / case.image_file
    if not image_path.exists():
        return False, f"Image not found: {image_path}", {}

    payload = {
        "requestId": f"batch-test-{idx}",
        "imageBase64": load_image_as_data_url(image_path),
        "selectedDocumentType": case.doc_type,
        "documentSide": case.doc_side,
        "profile": case.profile,
    }

    result = verify_image_payload(payload)
    analysis = result["analysis"]
    fields = analysis.get("extractedFields", {})
    val = analysis.get("validationResults", {})
    flags = analysis.get("flags", [])

    passes: list[str] = []
    failures: list[str] = []

    def chk(label: str, ok: bool, exp: str = "", got: str = "") -> None:
        if ok:
            passes.append(f"    PASS  {label}")
        else:
            detail = f" (expected={exp!r} got={got!r})" if exp or got else ""
            failures.append(f"    FAIL  {label}{detail}")

    detected_type = analysis.get("detectedDocumentType", "")
    chk("doc type", detected_type == case.doc_type, case.doc_type, detected_type)
    chk("documentDetected", analysis.get("documentDetected") is True)

    first = fields.get("first_name", "")
    last  = fields.get("last_name",  "")
    dob   = fields.get("date_of_birth", "")

    chk(f"first_name={first!r}",  first.upper() == case.expected_first,  case.expected_first, first)
    chk(f"last_name={last!r}",    last.upper()  == case.expected_last,   case.expected_last,  last)
    if case.expected_dob:
        chk(f"dob={dob!r}", dob == case.expected_dob, case.expected_dob, dob)
    else:
        passes.append(f"    SKIP  dob check (back-side, may be unreadable)")

    name_status = val.get("nameMatch", {}).get("status", "")
    dob_status  = val.get("dobMatch",  {}).get("status", "")
    exp_status  = val.get("expirationStatus", "")
    next_action = analysis.get("nextAction", "")

    chk(f"nameMatch={name_status!r}", name_status == "MATCH", "MATCH", name_status)
    if case.expected_dob:
        chk(f"dobMatch={dob_status!r}", dob_status == "MATCH", "MATCH", dob_status)
    else:
        passes.append(f"    SKIP  dobMatch check (back-side)")
    chk(f"expStatus={exp_status!r}", exp_status == case.expected_expiry_status, case.expected_expiry_status, exp_status)
    chk(f"nextAction={next_action!r}", next_action == case.expected_action, case.expected_action, next_action)

    flag_codes = [f["code"] for f in flags]
    chk("no IMAGE_QUALITY_LOW", "IMAGE_QUALITY_LOW" not in flag_codes)

    all_passed = not failures
    lines = passes + failures
    summary = f"  {'OK' if all_passed else 'FAIL'}  [{idx}] {case.label}"
    if not all_passed:
        summary += f"\n" + "\n".join(lines)
        summary += f"\n  Extracted: {json.dumps({k: v for k, v in fields.items() if v}, default=str)}"
        summary += f"\n  Flags: {[f['code'] for f in flags]}"
    return all_passed, summary, result


def main() -> None:
    print("=" * 72)
    print(f"BATCH REAL-IMAGE PIPELINE TEST  —  {len(CASES)} documents")
    print("=" * 72)
    print("Initialising EasyOCR (first call may take ~30s)...\n")

    total_pass = total_fail = 0
    results_log: list[str] = []

    for idx, case in enumerate(CASES, 1):
        print(f"  [{idx}/{len(CASES)}] {case.label} ...", end="", flush=True)
        ok, summary, _ = run_case(idx, case)
        if ok:
            total_pass += 1
            print(" PASS")
        else:
            total_fail += 1
            print(" FAIL")
            results_log.append(summary)

    print()
    print("─" * 72)
    if results_log:
        print("FAILURES:\n")
        for r in results_log:
            print(r)
            print()

    print(f"Result: {total_pass}/{len(CASES)} passed, {total_fail} failed")
    print("=" * 72)

    if total_fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
