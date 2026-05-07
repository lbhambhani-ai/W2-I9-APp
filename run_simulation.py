"""
Instawork W-2 Onboarding — Identity Verification Simulation
============================================================
Starts the Python OCR service on localhost:8001 and sends every
real ID image through it, exactly as the Express backend would.

Run:
    python run_simulation.py
"""

from __future__ import annotations

import base64
import json
import os
import signal
import subprocess
import sys
import time
import textwrap
from pathlib import Path
from typing import Any

# ── configuration ──────────────────────────────────────────────────────────────
SERVICE_PORT = 8001
SERVICE_URL  = f"http://localhost:{SERVICE_PORT}"
WORKSPACE    = Path(__file__).parent
ASSETS       = Path(
    "/Users/instawork/.cursor/projects/"
    "Users-instawork-Desktop-untitled-folder-3/assets"
)
VENV_PYTHON  = str(WORKSPACE / ".venv/bin/python")

# ── test cases (all real images captured in previous sessions) ─────────────────
CASES: list[dict[str, Any]] = [
    {
        "label": "Georgia Driver's License — Shayla Shenice Boyd",
        "image": "image-296ec9ef-c3d5-4647-84f2-92ae66f51a40.png",
        "selectedDocumentType": "drivers-license",
        "documentSide": "front",
        "profile": {
            "legalFirstName": "Shayla", "legalMiddleName": "Shenice",
            "legalLastName": "Boyd",    "dateOfBirth": "1998-05-07",
            "addressLine1": "2303 Charleston Pl", "city": "Dunwoody",
            "state": "GA", "zip": "30338",
        },
        "expect_first": "SHAYLA", "expect_last": "BOYD", "expect_dob": "1998-05-07",
    },
    {
        "label": "Florida Driver License — Tyrell Jaydon Brooks",
        "image": "image-ee753a59-8232-4a68-a402-417d606d82a4.png",
        "selectedDocumentType": "drivers-license",
        "documentSide": "front",
        "profile": {
            "legalFirstName": "Tyrell", "legalMiddleName": "Jaydon",
            "legalLastName": "Brooks",  "dateOfBirth": "2004-09-22",
            "addressLine1": "1338 Lake Bonny Dr W", "city": "Lakeland",
            "state": "FL", "zip": "33801",
        },
        "expect_first": "TYRELL", "expect_last": "BROOKS", "expect_dob": "2004-09-22",
    },
    {
        "label": "Georgia State ID — Shantika Shanae Anderson",
        "image": "file_front_5c106e24-2473-4e26-8fd0-f8e9434cefe6-c54125cb-c06f-4a21-8e48-544aa6032524.png",
        "selectedDocumentType": "state-id",
        "documentSide": "front",
        "profile": {
            "legalFirstName": "Shantika", "legalMiddleName": "Shanae",
            "legalLastName": "Anderson",  "dateOfBirth": "1989-09-28",
            "addressLine1": "3384 Mount Zion Rd Apt 1104", "city": "Stockbridge",
            "state": "GA", "zip": "30281",
        },
        "expect_first": "SHANTIKA", "expect_last": "ANDERSON", "expect_dob": "1989-09-28",
    },
    {
        "label": "EAD Back MRZ — Maureen Onyine Akabueze",
        "image": "file_back_f3dc79af-aa50-4b1d-b0e6-08d6650217b8-1e972ab4-b653-4d1b-b44f-8b8dd5cb9fa8.png",
        "selectedDocumentType": "employment-authorization-card",
        "documentSide": "back",
        "profile": {
            "legalFirstName": "Maureen", "legalMiddleName": "Onyine",
            "legalLastName": "Akabueze", "dateOfBirth": "1996-11-28",
        },
        "expect_first": "MAUREEN", "expect_last": "AKABUEZE", "expect_dob": "",
    },
    {
        "label": "US Passport — Chiara Losa Ahio",
        "image": "file_front_5479c41f-6c8f-46f4-a7b7-20b100d9a744-c819c864-d0d4-4503-bc97-93aeb2d1aea4.png",
        "selectedDocumentType": "passport",
        "documentSide": "front",
        "profile": {
            "legalFirstName": "Chiara", "legalMiddleName": "Losa",
            "legalLastName": "Ahio",   "dateOfBirth": "2008-02-24",
        },
        "expect_first": "CHIARA", "expect_last": "AHIO", "expect_dob": "2008-02-24",
    },
    {
        "label": "US Passport — Muhammad Abdullah Abbasi",
        "image": "file_front_06e48a77-0e34-477a-82f6-4fe1e6d78067-ac6d933c-bd8b-4d3f-847e-03d036968494.png",
        "selectedDocumentType": "passport",
        "documentSide": "front",
        "profile": {
            "legalFirstName": "Muhammad", "legalMiddleName": "Abdullah",
            "legalLastName": "Abbasi",    "dateOfBirth": "2004-07-09",
        },
        "expect_first": "MUHAMMAD", "expect_last": "ABBASI", "expect_dob": "2004-07-09",
    },
    {
        "label": "EAD Front — Maureen Akabueze",
        "image": "file_front_220f9111-6dd9-423c-a0b7-890abde2edeb-b602b1a4-82d6-48c3-8c8f-73d66a2be597.png",
        "selectedDocumentType": "employment-authorization-card",
        "documentSide": "front",
        "profile": {
            "legalFirstName": "Maureen", "legalMiddleName": "Onyine",
            "legalLastName": "Akabueze", "dateOfBirth": "1996-11-28",
        },
        "expect_first": "MAUREEN", "expect_last": "AKABUEZE", "expect_dob": "1996-11-28",
    },
    {
        "label": "US Passport — Henry Chukwuemeka Benjamin",
        "image": "file_front_22c00e13-3833-4129-a106-f5617c4810a4-0b7294b9-2780-4585-b85b-3ac891ea7322.png",
        "selectedDocumentType": "passport",
        "documentSide": "front",
        "profile": {
            "legalFirstName": "Henry", "legalMiddleName": "Chukwuemeka",
            "legalLastName": "Benjamin", "dateOfBirth": "2006-11-20",
        },
        "expect_first": "HENRY", "expect_last": "BENJAMIN", "expect_dob": "2006-11-20",
    },
    {
        "label": "Massachusetts DL — Amir Khikmatovich Abdujabbarov",
        "image": "file_front_5e654dbb-feb5-4e83-8790-c67ebfd8cc8b-c3d18b47-8a3e-486b-8157-b8bc4290a8a5.png",
        "selectedDocumentType": "drivers-license",
        "documentSide": "front",
        "profile": {
            "legalFirstName": "Amir", "legalMiddleName": "Khikmatovich",
            "legalLastName": "Abdujabbarov", "dateOfBirth": "1996-01-29",
            "addressLine1": "490 Union St Apt 25", "city": "Rockland",
            "state": "MA", "zip": "02370",
        },
        "expect_first": "AMIR", "expect_last": "ABDUJABBAROV", "expect_dob": "1996-01-29",
    },
    {
        "label": "Alabama DL — Jean Creamer Allen",
        "image": "file_front_059d0a2f-f282-404a-8b24-7319aa64bfa3-45eafced-ebcb-4236-905d-5f80af5b7175.png",
        "selectedDocumentType": "drivers-license",
        "documentSide": "front",
        "profile": {
            "legalFirstName": "Jean", "legalMiddleName": "Creamer",
            "legalLastName": "Allen",  "dateOfBirth": "1945-07-01",
            "addressLine1": "4140 Hillsboro Dr", "city": "Tuscaloosa",
            "state": "AL", "zip": "35404",
        },
        "expect_first": "JEAN", "expect_last": "ALLEN", "expect_dob": "1945-07-01",
    },
    {
        "label": "Illinois State ID — Kamar Deron Brown",
        "image": "image-a47091d3-2029-4fcc-bda0-3413d8f4fe3b.png",
        "selectedDocumentType": "state-id",
        "documentSide": "front",
        "profile": {
            "legalFirstName": "Kamar", "legalMiddleName": "Deron",
            "legalLastName": "Brown",  "dateOfBirth": "2006-11-04",
            "addressLine1": "8040 S Normal Ave", "city": "Chicago",
            "state": "IL", "zip": "60620",
        },
        "expect_first": "KAMAR", "expect_last": "BROWN", "expect_dob": "2006-11-04",
    },
    {
        "label": "Florida DL — Ronald Henry Brown Jr",
        "image": "image-8cbb5925-79b8-4e19-9bc9-ed50bf7581ca.png",
        "selectedDocumentType": "drivers-license",
        "documentSide": "front",
        "profile": {
            "legalFirstName": "Ronald", "legalMiddleName": "Henry",
            "legalLastName": "Brown",   "dateOfBirth": "1999-03-12",
            "addressLine1": "64 Hayward Dr", "city": "Midway",
            "state": "FL", "zip": "32343",
        },
        "expect_first": "RONALD", "expect_last": "BROWN", "expect_dob": "1999-03-12",
    },
]

# ── helpers ────────────────────────────────────────────────────────────────────
BOLD  = "\033[1m"
GREEN = "\033[32m"
RED   = "\033[31m"
YELLOW= "\033[33m"
CYAN  = "\033[36m"
RESET = "\033[0m"
DIM   = "\033[2m"

def b(s: str) -> str: return f"{BOLD}{s}{RESET}"
def g(s: str) -> str: return f"{GREEN}{s}{RESET}"
def r(s: str) -> str: return f"{RED}{s}{RESET}"
def y(s: str) -> str: return f"{YELLOW}{s}{RESET}"
def c(s: str) -> str: return f"{CYAN}{s}{RESET}"
def d(s: str) -> str: return f"{DIM}{s}{RESET}"

def load_image(fname: str) -> str:
    path = ASSETS / fname
    if not path.exists():
        raise FileNotFoundError(f"Image not found: {path}")
    raw = path.read_bytes()
    suffix = path.suffix.lstrip(".").lower()
    mime = "jpeg" if suffix in ("jpg","jpeg") else "png"
    return f"data:image/{mime};base64," + base64.b64encode(raw).decode()

def wait_for_service(url: str, timeout: int = 60) -> bool:
    import urllib.request
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{url}/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(1)
    return False

def post_verify(case: dict[str, Any], idx: int) -> dict[str, Any]:
    import urllib.request, urllib.error
    payload = {
        "requestId": f"sim-{idx:02d}",
        "imageBase64": load_image(case["image"]),
        "selectedDocumentType": case["selectedDocumentType"],
        "documentSide": case["documentSide"],
        "profile": case["profile"],
    }
    body = json.dumps(payload).encode()
    req  = urllib.request.Request(
        f"{SERVICE_URL}/verify",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read())

def action_color(action: str) -> str:
    if action == "CONTINUE":    return g(action)
    if action in ("RETAKE_PHOTO","REQUEST_FRONT_IMAGE","REQUEST_BACK_IMAGE"): return y(action)
    return r(action)

def render_result(idx: int, case: dict, result: dict, elapsed: float) -> tuple[bool, list[str]]:
    a      = result.get("analysis", {})
    fields = a.get("extractedFields", {})
    val    = a.get("validationResults", {})
    flags  = a.get("flags", [])

    first      = fields.get("first_name", "")
    mid        = fields.get("middle_name", "")
    last       = fields.get("last_name", "")
    dob        = fields.get("date_of_birth", "")
    exp_date   = fields.get("expiration_date", "")
    doc_num    = fields.get("document_number", "")
    detected   = a.get("detectedDocumentType", "unknown")
    action     = a.get("nextAction", "?")
    compliance = a.get("complianceEligibility", False)
    nm_status  = val.get("nameMatch", {}).get("status", "?")
    dob_status = val.get("dobMatch",  {}).get("status", "?")
    exp_status = val.get("expirationStatus", "?")

    fails: list[str] = []
    def chk(label: str, ok: bool, exp: str = "", got: str = "") -> str:
        if ok:
            return g("✓") + f" {label}"
        detail = f" → expected {exp!r} got {got!r}" if exp or got else ""
        fails.append(f"{label}{detail}")
        return r("✗") + f" {label}{detail}"

    exp_first = case.get("expect_first","")
    exp_last  = case.get("expect_last","")
    exp_dob   = case.get("expect_dob","")

    rows = [
        chk(f"doc type={detected}",          detected == case["selectedDocumentType"],   case["selectedDocumentType"], detected),
        chk(f"first={first!r}",              not exp_first or first.upper()==exp_first,   exp_first, first),
        chk(f"last={last!r}",               not exp_last  or last.upper()==exp_last,      exp_last,  last),
    ]
    if exp_dob:
        rows.append(chk(f"dob={dob!r}",     dob==exp_dob, exp_dob, dob))
    else:
        rows.append(d("– dob (back-side, skipped)"))

    rows += [
        chk(f"nameMatch={nm_status}",       nm_status=="MATCH",  "MATCH", nm_status),
    ]
    if exp_dob:
        rows.append(chk(f"dobMatch={dob_status}", dob_status=="MATCH", "MATCH", dob_status))
    rows += [
        chk(f"expStatus={exp_status}",      exp_status in ("VALID","EXPIRES_SOON"), "VALID|EXPIRES_SOON", exp_status),
        chk(f"action={action}",             action=="CONTINUE", "CONTINUE", action),
    ]

    flag_codes = [f["code"] for f in flags]
    ok_overall = not fails

    name_str = " ".join(p for p in [first, mid, last] if p) or r("not extracted")
    icon = g("●") if ok_overall else r("●")
    case_label = case["label"]
    lines = [
        f"{icon} {b(f'[{idx:02d}] {case_label}')}  {d(f'{elapsed:.1f}s')}",
        f"     {b('Decision')} : {action_color(action)}   {b('Eligible')} : {g('YES') if compliance else r('NO')}",
        f"     {b('Name')}     : {name_str}",
        f"     {b('DOB')}      : {dob or r('not extracted')}   {b('Expires')} : {exp_date or '?'}   {b('Doc#')} : {doc_num or '—'}",
        f"     {b('Checks')}   : " + "  ".join(rows),
    ]
    if flag_codes:
        lines.append(f"     {b('Flags')}    : " + "  ".join(y(fc) for fc in flag_codes))
    return ok_overall, lines


# ── main ───────────────────────────────────────────────────────────────────────
def main() -> None:
    print()
    print(b("=" * 70))
    print(b("  Instawork W-2 Identity Verification  —  OCR Pipeline Simulation"))
    print(b("=" * 70))
    print(f"  Service  : {c(SERVICE_URL)}")
    print(f"  Documents: {len(CASES)} real card images")
    print()

    # ── start the service ──────────────────────────────────────────────────────
    print(b("Starting identity service..."), end="", flush=True)
    env = {**os.environ, "PYTHONPATH": str(WORKSPACE)}
    proc = subprocess.Popen(
        [VENV_PYTHON, "-m", "uvicorn", "identity_service.app:app",
         "--host", "0.0.0.0", "--port", str(SERVICE_PORT),
         "--log-level", "error"],
        cwd=str(WORKSPACE), env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    if not wait_for_service(SERVICE_URL, timeout=30):
        print(r(" FAILED — could not reach service"))
        proc.terminate()
        sys.exit(1)
    print(g(" ready\n"))

    total_pass = total_fail = 0
    all_lines: list[list[str]] = []

    # ── run each case ──────────────────────────────────────────────────────────
    for idx, case in enumerate(CASES, 1):
        label = case["label"]
        short = textwrap.shorten(label, 50, placeholder="…")
        print(f"  [{idx:02d}/{len(CASES)}] {short:<52}", end="", flush=True)
        t0 = time.time()
        try:
            result  = post_verify(case, idx)
            elapsed = time.time() - t0
            ok, lines = render_result(idx, case, result, elapsed)
            if ok:
                total_pass += 1
                print(g("PASS") + d(f"  {elapsed:.1f}s"))
            else:
                total_fail += 1
                print(r("FAIL") + d(f"  {elapsed:.1f}s"))
            all_lines.append(lines)
        except Exception as exc:
            elapsed = time.time() - t0
            total_fail += 1
            print(r(f"ERROR  {exc}"))
            all_lines.append([r(f"[{idx:02d}] {label}  ERROR: {exc}")])

    # ── detailed report ────────────────────────────────────────────────────────
    print()
    print(b("─" * 70))
    print(b("  DETAILED RESULTS"))
    print(b("─" * 70))
    for lines in all_lines:
        for line in lines:
            print(line)
        print()

    # ── summary ───────────────────────────────────────────────────────────────
    print(b("─" * 70))
    bar = g("█") * total_pass + r("░") * total_fail
    pct = int(100 * total_pass / len(CASES)) if CASES else 0
    print(f"  {bar}  {b(f'{total_pass}/{len(CASES)}')} passed  ({pct}%)")
    if total_fail == 0:
        print(f"  {g(b('All documents verified successfully — pipeline is production-ready.'))}")
    else:
        print(f"  {y(b(f'{total_fail} document(s) need attention — see failures above.'))}")
    print(b("=" * 70))
    print()

    proc.terminate()
    proc.wait()
    sys.exit(0 if total_fail == 0 else 1)


if __name__ == "__main__":
    main()
