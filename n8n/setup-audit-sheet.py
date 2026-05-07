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

SHEET_ID = "13ykmz2E-3fYnZOmMEDZAbFwuVSrOGSuKZmu1F8M13XQ"
TAB_NAME = "audit_log"

# ── Column definitions ─────────────────────────────────────────────────────────
# Each entry: (header_label, width_pixels, section_color_hex)
# Sections are color-coded for visual grouping in the sheet.

COLUMNS = [
    # ── Session / Meta (light blue-grey) ──────────────────────────────────────
    ("Timestamp",              180, "BDD7EE"),
    ("Session ID",             220, "BDD7EE"),
    ("Record Kind",            120, "BDD7EE"),
    ("Flow",                   100, "BDD7EE"),
    ("Attempt #",               80, "BDD7EE"),
    ("Result",                 110, "BDD7EE"),
    ("Side",                    80, "BDD7EE"),

    # ── User Profile (light green) ─────────────────────────────────────────────
    ("First Name",             130, "C6EFCE"),
    ("Last Name",              130, "C6EFCE"),
    ("Date of Birth",          130, "C6EFCE"),
    ("Email",                  220, "C6EFCE"),
    ("Phone",                  140, "C6EFCE"),

    # ── Document Info (light yellow) ───────────────────────────────────────────
    ("Doc Type (Selected)",    180, "FFEB9C"),
    ("I-9 List",                80, "FFEB9C"),
    ("Doc ID",                 160, "FFEB9C"),
    ("Doc Label",              200, "FFEB9C"),
    ("Immigration Status",     200, "FFEB9C"),
    ("Document Path",          200, "FFEB9C"),

    # ── Google Drive (light purple) ────────────────────────────────────────────
    ("Drive File ID",          240, "E2CFFF"),
    ("Drive File URL",         300, "E2CFFF"),

    # ── Analysis Output (light orange) ────────────────────────────────────────
    ("User Message",           360, "FCE4D6"),
    ("Flags (JSON)",           300, "FCE4D6"),

    # ── Identity Verification Summary (light teal) ────────────────────────────
    ("ID Final Status",        140, "DDEBF7"),
    ("ID Attempt Count",       120, "DDEBF7"),
    ("ID Drive Links",         300, "DDEBF7"),

    # ── I-9 Summary (light pink) ───────────────────────────────────────────────
    ("I-9 Final Status",       140, "FCE4D6"),
    ("I-9 Attempt Count",      120, "FCE4D6"),
    ("I-9 Drive Links",        300, "FCE4D6"),
    ("I-9 Selected Docs",      300, "FCE4D6"),

    # ── Feedback (light lavender) ──────────────────────────────────────────────
    ("Rating (1–5)",            100, "EAD1DC"),
    ("Feedback Comments",       400, "EAD1DC"),
]

HEADER_LABELS = [col[0] for col in COLUMNS]

# ── n8n field mapping (audit workflow Normalize node key → column header) ──────
# This shows which n8n output key maps to which column (for reference).
N8N_FIELD_MAP = {
    "timestamp":            "Timestamp",
    "sessionId":            "Session ID",
    "recordKind":           "Record Kind",
    "flow":                 "Flow",
    "attemptNumber":        "Attempt #",
    "resultStatus":         "Result",
    "side":                 "Side",
    "userFirstName":        "First Name",
    "userLastName":         "Last Name",
    "dateOfBirth":          "Date of Birth",
    "email":                "Email",
    "phone":                "Phone",
    "selectedDocumentType": "Doc Type (Selected)",
    "selectedList":         "I-9 List",
    "selectedDocumentId":   "Doc ID",
    "selectedDocumentLabel":"Doc Label",
    "immigrationStatus":    "Immigration Status",
    "documentPath":         "Document Path",
    "googleDriveFileId":    "Drive File ID",
    "googleDriveFileUrl":   "Drive File URL",
    "userMessage":          "User Message",
    "flagsJson":            "Flags (JSON)",
    "identityFinalStatus":  "ID Final Status",
    "identityAttemptCount": "ID Attempt Count",
    "identityDriveLinks":   "ID Drive Links",
    "i9FinalStatus":        "I-9 Final Status",
    "i9AttemptCount":       "I-9 Attempt Count",
    "i9DriveLinks":         "I-9 Drive Links",
    "i9SelectedDocuments":  "I-9 Selected Docs",
    "rating":               "Rating (1–5)",
    "feedback":             "Feedback Comments",
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
    print("  Cols  1-7  (A-G)  : Session/Meta         → Blue-grey  #BDD7EE")
    print("  Cols  8-12 (H-L)  : User Profile         → Green      #C6EFCE")
    print("  Cols 13-18 (M-R)  : Document Info        → Yellow     #FFEB9C")
    print("  Cols 19-20 (S-T)  : Google Drive         → Purple     #E2CFFF")
    print("  Cols 21-22 (U-V)  : Analysis Output      → Orange     #FCE4D6")
    print("  Cols 23-25 (W-Y)  : Identity Summary     → Teal       #DDEBF7")
    print("  Cols 26-29 (Z-AC) : I-9 Summary          → Pink       #FCE4D6")
    print("  Cols 30-31 (AD-AE): Feedback             → Lavender   #EAD1DC")


if __name__ == "__main__":
    setup_sheet()
