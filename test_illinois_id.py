"""
Real-image pipeline test — Illinois State ID (Identification Card)
Kamar Deron Brown, DOB 11/04/2006
"""
from __future__ import annotations
import base64, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from identity_service.pipeline import verify_image_payload

IMAGE_PATH = Path("/Users/instawork/.cursor/projects/Users-instawork-Desktop-untitled-folder-3/assets/image-a47091d3-2029-4fcc-bda0-3413d8f4fe3b.png")

PROFILE = {
    "legalFirstName":  "Kamar",
    "legalMiddleName": "Deron",
    "legalLastName":   "Brown",
    "dateOfBirth":     "2006-11-04",
    "addressLine1":    "8040 S Normal Ave",
    "city":            "Chicago",
    "state":           "IL",
    "zip":             "60620",
}

def load(path):
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()

result = verify_image_payload({
    "requestId":            "test-illinois-id",
    "imageBase64":          load(IMAGE_PATH),
    "selectedDocumentType": "state-id",
    "documentSide":         "front",
    "profile":              PROFILE,
})

a      = result["analysis"]
fields = a.get("extractedFields", {})
val    = a.get("validationResults", {})
flags  = a.get("flags", [])

print("=" * 65)
print("REAL-IMAGE TEST  —  Illinois State ID")
print("=" * 65)
print(json.dumps(result, indent=2, default=str))
print()

passes = failures = 0
def chk(label, ok, exp="", got=""):
    global passes, failures
    if ok:
        print(f"  PASS  {label}"); passes += 1
    else:
        d = f" (exp={exp!r} got={got!r})" if exp or got else ""
        print(f"  FAIL  {label}{d}"); failures += 1

detected   = a.get("detectedDocumentType","")
first      = fields.get("first_name","")
last       = fields.get("last_name","")
dob        = fields.get("date_of_birth","")
exp_status = val.get("expirationStatus","")
nm_status  = val.get("nameMatch",{}).get("status","")
dob_status = val.get("dobMatch",{}).get("status","")
action     = a.get("nextAction","")
compliance = a.get("complianceEligibility", False)

chk("doc type → state-id",          detected   == "state-id",    "state-id",    detected)
chk("documentDetected",             a.get("documentDetected") is True)
chk(f"first_name={first!r}",        first.upper() == "KAMAR",    "KAMAR",       first)
chk(f"last_name={last!r}",          last.upper()  == "BROWN",    "BROWN",       last)
chk(f"dob={dob!r}",                 dob == "2006-11-04",         "2006-11-04",  dob)
chk(f"nameMatch={nm_status!r}",     nm_status  == "MATCH",       "MATCH",       nm_status)
chk(f"dobMatch={dob_status!r}",     dob_status == "MATCH",       "MATCH",       dob_status)
chk(f"expStatus={exp_status!r}",    exp_status == "VALID",       "VALID",       exp_status)
chk(f"nextAction={action!r}",       action == "CONTINUE",        "CONTINUE",    action)
chk("complianceEligibility",        compliance is True)
chk("no IMAGE_QUALITY_LOW",         "IMAGE_QUALITY_LOW" not in [f["code"] for f in flags])

print(f"\nResult: {passes} passed, {failures} failed")
if not failures:
    mid = fields.get("middle_name","")
    print(f"  Name    : {' '.join(p for p in [first,mid,last] if p)}")
    print(f"  DOB     : {dob}")
    print(f"  Doc type: {detected}")
    print(f"  Expires : {fields.get('expiration_date','not extracted')}")
else:
    print("Flags:", [f["code"] for f in flags])
sys.exit(1 if failures else 0)
