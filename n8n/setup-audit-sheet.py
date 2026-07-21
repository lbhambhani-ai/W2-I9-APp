"""
Google Sheets Audit Log Setup Script
=====================================
Creates the "audit_log" tab in your Google Sheet with:
  - Frozen header row
  - Bold, colored header cells grouped by section
  - Column widths sized for readability
  - Alternating row banding

Requirements:
  pip install google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client

Usage:
  1. Download your service account JSON key or use OAuth credentials
  2. Set GOOGLE_APPLICATION_CREDENTIALS to the path of your key file
     export GOOGLE_APPLICATION_CREDENTIALS="/path/to/key.json"
  3. Run:
     python n8n/setup-audit-sheet.py

  OR use the manual header list below if you prefer to paste headers yourself.
"""

SHEET_ID = "19MM98YCU_Qtpz8YEXL6l6cHlQgVMNMAsbcDkA99e524"
TAB_NAME = "audit_log"

# ── Column definitions ─────────────────────────────────────────────────────────
# Each entry: (header_label, width_pixels, section_color_hex)
# One row per event, 17 columns, matching the n8n "Normalize Audit Row" output.

COLUMNS = [
    # ── Session / Meta (light blue-grey) ──────────────────────────────────────
    ("Timestamp",              180, "BDD7EE"),
    ("Event",                  150, "BDD7EE"),
    ("Session ID",             220, "BDD7EE"),

    # ── User: name + email only (light green) ─────────────────────────────────
    ("Name",                   200, "C6EFCE"),
    ("Email",                  240, "C6EFCE"),

    # ── Attempt / Document (light yellow) ─────────────────────────────────────
    ("Flow",                   100, "FFEB9C"),
    ("Attempt #",               80, "FFEB9C"),
    ("Result",                 150, "FFEB9C"),
    ("Document",               220, "FFEB9C"),

    # ── AWS S3 file (light purple) ─────────────────────────────────────────────
    ("File Name",              200, "E2CFFF"),
    ("AWS File Location",      320, "E2CFFF"),
    ("AWS File URL",           360, "E2CFFF"),

    # ── Status / Detail (light orange) ────────────────────────────────────────
    ("Immigration Status",     180, "FCE4D6"),
    ("Details",                420, "FCE4D6"),
    ("Address",                320, "FCE4D6"),

    # ── Intercom (light lavender) ──────────────────────────────────────────────
    ("Intercom User ID",       160, "EAD1DC"),
    ("Intercom Ticket ID",     150, "EAD1DC"),
]

HEADER_LABELS = [col[0] for col in COLUMNS]

# ── n8n field mapping (audit workflow Normalize node key → column header) ──────
# This shows which n8n output key maps to which column (for reference).
N8N_FIELD_MAP = {
    "Timestamp":           "Timestamp",
    "Event":               "Event",
    "Session ID":          "Session ID",
    "Name":                "Name",
    "Email":               "Email",
    "Flow":                "Flow",
    "Attempt #":           "Attempt #",
    "Result":              "Result",
    "Document":            "Document",
    "File Name":           "File Name",
    "AWS File Location":   "AWS File Location",
    "AWS File URL":        "AWS File URL",
    "Immigration Status":  "Immigration Status",
    "Details":             "Details",
    "Address":             "Address",
    "Intercom User ID":    "Intercom User ID",
    "Intercom Ticket ID":  "Intercom Ticket ID",
}


def hex_to_rgb(hex_color: str) -> dict:
    """Convert 6-char hex string to {red, green, blue} floats (0–1)."""
    r = int(hex_color[0:2], 16) / 255
    g = int(hex_color[2:4], 16) / 255
    b = int(hex_color[4:6], 16) / 255
    return {"red": r, "green": g, "blue": b}


def setup_sheet():
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
    except ImportError:
        print("Missing dependencies. Run: pip install google-auth google-api-python-client")
        return

    import os
    creds_file = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not creds_file:
        print_manual_instructions()
        return

    SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = service_account.Credentials.from_service_account_file(creds_file, scopes=SCOPES)
    service = build("sheets", "v4", credentials=creds)
    sheets = service.spreadsheets()

    # Get existing sheet metadata to find/create the tab
    meta = sheets.get(spreadsheetId=SHEET_ID).execute()
    existing_tabs = {s["properties"]["title"]: s["properties"]["sheetId"]
                     for s in meta.get("sheets", [])}

    if TAB_NAME not in existing_tabs:
        # Create the tab
        sheets.batchUpdate(spreadsheetId=SHEET_ID, body={
            "requests": [{"addSheet": {"properties": {"title": TAB_NAME}}}]
        }).execute()
        meta = sheets.get(spreadsheetId=SHEET_ID).execute()
        existing_tabs = {s["properties"]["title"]: s["properties"]["sheetId"]
                         for s in meta.get("sheets", [])}

    sheet_id = existing_tabs[TAB_NAME]
    num_cols = len(COLUMNS)

    requests = []

    # 1. Write header row values
    sheets.values().update(
        spreadsheetId=SHEET_ID,
        range=f"{TAB_NAME}!A1",
        valueInputOption="RAW",
        body={"values": [HEADER_LABELS]}
    ).execute()

    # 2. Format each header cell: bold, background color, center-aligned, white text
    for col_idx, (label, width, hex_bg) in enumerate(COLUMNS):
        requests.append({
            "repeatCell": {
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": 0, "endRowIndex": 1,
                    "startColumnIndex": col_idx, "endColumnIndex": col_idx + 1
                },
                "cell": {
                    "userEnteredFormat": {
                        "backgroundColor": hex_to_rgb(hex_bg),
                        "textFormat": {
                            "bold": True,
                            "fontSize": 10,
                            "foregroundColor": {"red": 0.13, "green": 0.13, "blue": 0.13}
                        },
                        "horizontalAlignment": "CENTER",
                        "verticalAlignment": "MIDDLE",
                        "wrapStrategy": "CLIP"
                    }
                },
                "fields": "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)"
            }
        })

    # 3. Set column widths
    for col_idx, (label, width, _) in enumerate(COLUMNS):
        requests.append({
            "updateDimensionProperties": {
                "range": {
                    "sheetId": sheet_id,
                    "dimension": "COLUMNS",
                    "startIndex": col_idx,
                    "endIndex": col_idx + 1
                },
                "properties": {"pixelSize": width},
                "fields": "pixelSize"
            }
        })

    # 4. Freeze header row
    requests.append({
        "updateSheetProperties": {
            "properties": {
                "sheetId": sheet_id,
                "gridProperties": {"frozenRowCount": 1}
            },
            "fields": "gridProperties.frozenRowCount"
        }
    })

    # 5. Set row height for header
    requests.append({
        "updateDimensionProperties": {
            "range": {
                "sheetId": sheet_id,
                "dimension": "ROWS",
                "startIndex": 0,
                "endIndex": 1
            },
            "properties": {"pixelSize": 36},
            "fields": "pixelSize"
        }
    })

    # 6. Alternating row banding (rows 2 onward)
    requests.append({
        "addBanding": {
            "bandedRange": {
                "bandedRangeId": 1,
                "range": {
                    "sheetId": sheet_id,
                    "startRowIndex": 1,
                    "startColumnIndex": 0,
                    "endColumnIndex": num_cols
                },
                "rowProperties": {
                    "headerColor": {"red": 0.95, "green": 0.95, "blue": 0.95},
                    "firstBandColor": {"red": 1, "green": 1, "blue": 1},
                    "secondBandColor": {"red": 0.97, "green": 0.97, "blue": 0.99}
                }
            }
        }
    })

    # 7. Border on header row bottom
    requests.append({
        "updateBorders": {
            "range": {
                "sheetId": sheet_id,
                "startRowIndex": 0, "endRowIndex": 1,
                "startColumnIndex": 0, "endColumnIndex": num_cols
            },
            "bottom": {
                "style": "SOLID_MEDIUM",
                "color": {"red": 0.4, "green": 0.4, "blue": 0.4}
            }
        }
    })

    sheets.batchUpdate(spreadsheetId=SHEET_ID, body={"requests": requests}).execute()
    print(f"Sheet '{TAB_NAME}' setup complete with {num_cols} columns.")
    print(f"Open: https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit")


def print_manual_instructions():
    """Print the headers to paste manually if no service account is available."""
    print("\nNo GOOGLE_APPLICATION_CREDENTIALS set.")
    print("Paste these headers into Row 1 of the 'audit_log' tab:\n")
    print("\t".join(HEADER_LABELS))
    print(f"\nTotal columns: {len(HEADER_LABELS)}")
    print("\nColumn color groupings:")
    print("  Cols  1-3  (A-C)  : Session/Meta   → Blue-grey  #BDD7EE")
    print("  Cols  4-5  (D-E)  : User (name+email) → Green    #C6EFCE")
    print("  Cols  6-9  (F-I)  : Attempt/Document → Yellow    #FFEB9C")
    print("  Cols 10-12 (J-L)  : AWS S3 File    → Purple     #E2CFFF")
    print("  Cols 13-15 (M-O)  : Status/Detail/Address → Orange #FCE4D6")
    print("  Cols 16-17 (P-Q)  : Intercom       → Lavender   #EAD1DC")


if __name__ == "__main__":
    setup_sheet()
