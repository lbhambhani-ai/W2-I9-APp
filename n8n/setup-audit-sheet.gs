/**
 * Onboarding Audit Log — Google Sheets Setup
 * ============================================
 * Run this script once from inside your Google Sheet to:
 *   1. Create (or reset) the "audit_log" tab
 *   2. Write all 31 column headers
 *   3. Apply color-coded section backgrounds
 *   4. Bold + center-align headers, freeze row 1
 *   5. Set column widths
 *   6. Add alternating row banding
 *   7. Add a thick bottom border under the header row
 *
 * HOW TO RUN:
 *   1. Open your Google Sheet:
 *      https://docs.google.com/spreadsheets/d/13ykmz2E-3fYnZOmMEDZAbFwuVSrOGSuKZmu1F8M13XQ/edit
 *   2. Click Extensions → Apps Script
 *   3. Paste this entire file into the editor (replace any existing code)
 *   4. Click ▶ Run → select "setupAuditLog"
 *   5. Authorize when prompted (it only needs access to this sheet)
 *   6. Done — close the Apps Script tab and refresh your sheet
 *
 * Safe to re-run: it clears and rebuilds the header row without touching data rows.
 */

var TAB_NAME = "audit_log";

// ── Column definitions ────────────────────────────────────────────────────────
// Format: [header label, width in pixels, background hex color]
// Colors group columns by section for easy reading.
var COLUMNS = [
  // Section: Session / Meta — blue-grey
  ["Timestamp",            180, "#BDD7EE"],
  ["Session ID",           220, "#BDD7EE"],
  ["Record Kind",          120, "#BDD7EE"],
  ["Flow",                 100, "#BDD7EE"],
  ["Attempt #",             80, "#BDD7EE"],
  ["Result",               110, "#BDD7EE"],
  ["Side",                  80, "#BDD7EE"],

  // Section: User Profile — light green
  ["First Name",           130, "#C6EFCE"],
  ["Last Name",            130, "#C6EFCE"],
  ["Date of Birth",        130, "#C6EFCE"],
  ["Email",                220, "#C6EFCE"],
  ["Phone",                140, "#C6EFCE"],

  // Section: Document Info — light yellow
  ["Doc Type (Selected)",  180, "#FFEB9C"],
  ["I-9 List",              80, "#FFEB9C"],
  ["Doc ID",               160, "#FFEB9C"],
  ["Doc Label",            200, "#FFEB9C"],
  ["Immigration Status",   200, "#FFEB9C"],
  ["Document Path",        200, "#FFEB9C"],

  // Section: Google Drive — light purple
  ["Drive File ID",        240, "#E2CFFF"],
  ["Drive File URL",       300, "#E2CFFF"],

  // Section: Analysis Output — light orange
  ["User Message",         360, "#FCE4D6"],
  ["Flags (JSON)",         300, "#FCE4D6"],

  // Section: Identity Verification Summary — light teal
  ["ID Final Status",      140, "#DDEBF7"],
  ["ID Attempt Count",     120, "#DDEBF7"],
  ["ID Drive Links",       300, "#DDEBF7"],

  // Section: I-9 Summary — light pink
  ["I-9 Final Status",     140, "#F4CCCC"],
  ["I-9 Attempt Count",    120, "#F4CCCC"],
  ["I-9 Drive Links",      300, "#F4CCCC"],
  ["I-9 Selected Docs",    300, "#F4CCCC"],

  // Section: Feedback — light lavender
  ["Rating (1–5)",         100, "#EAD1DC"],
  ["Feedback Comments",    400, "#EAD1DC"]
];

// ── Main function — run this ──────────────────────────────────────────────────
function setupAuditLog() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_NAME);

  // Create the tab if it doesn't exist
  if (!sheet) {
    sheet = ss.insertSheet(TAB_NAME);
    Logger.log('Created new tab: ' + TAB_NAME);
  } else {
    Logger.log('Tab already exists, rebuilding headers only.');
  }

  var numCols = COLUMNS.length;

  // ── 1. Expand columns if needed ───────────────────────────────────────────
  if (sheet.getMaxColumns() < numCols) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), numCols - sheet.getMaxColumns());
  }

  // ── 2. Write header labels into row 1 ────────────────────────────────────
  var headerRow = COLUMNS.map(function(col) { return col[0]; });
  var headerRange = sheet.getRange(1, 1, 1, numCols);
  headerRange.setValues([headerRow]);

  // ── 3. Apply per-column background colors + text formatting ──────────────
  for (var i = 0; i < numCols; i++) {
    var cell = sheet.getRange(1, i + 1);
    cell.setBackground(COLUMNS[i][2]);
    cell.setFontWeight("bold");
    cell.setFontSize(10);
    cell.setFontColor("#1F1F1F");
    cell.setHorizontalAlignment("center");
    cell.setVerticalAlignment("middle");
    cell.setWrap(false);
  }

  // ── 4. Set column widths ──────────────────────────────────────────────────
  for (var j = 0; j < numCols; j++) {
    sheet.setColumnWidth(j + 1, COLUMNS[j][1]);
  }

  // ── 5. Freeze header row ──────────────────────────────────────────────────
  sheet.setFrozenRows(1);

  // ── 6. Set header row height ──────────────────────────────────────────────
  sheet.setRowHeight(1, 36);

  // ── 7. Thick bottom border under header ───────────────────────────────────
  headerRange.setBorder(
    null, null, true, null, null, null,
    "#555555",
    SpreadsheetApp.BorderStyle.SOLID_MEDIUM
  );

  // ── 8. Alternating row banding ────────────────────────────────────────────
  // Remove existing bandings first to avoid duplicates on re-run
  var existingBandings = sheet.getBandings();
  for (var b = 0; b < existingBandings.length; b++) {
    existingBandings[b].remove();
  }

  // Apply banding from row 2 downward (1000 rows pre-allocated)
  var dataRange = sheet.getRange(2, 1, 1000, numCols);
  dataRange.applyRowBanding(
    SpreadsheetApp.BandingTheme.LIGHT_GREY,
    false,  // no header
    false   // no footer
  );

  // ── 9. Set default row height for data rows ───────────────────────────────
  sheet.setRowHeightsForced(2, sheet.getMaxRows() - 1, 24);

  // ── 10. Make Drive File URL column show clickable links ───────────────────
  // Column 20 = "Drive File URL" — format as plain text (links auto-detect)
  sheet.getRange(2, 20, 1000, 1).setWrap(false);

  Logger.log('✅ Audit log sheet setup complete!');
  Logger.log('Columns: ' + numCols);
  Logger.log('Open: https://docs.google.com/spreadsheets/d/13ykmz2E-3fYnZOmMEDZAbFwuVSrOGSuKZmu1F8M13XQ/edit');

  // Show a popup confirmation inside the sheet
  SpreadsheetApp.getUi().alert(
    '✅ Audit Log Setup Complete',
    'The "' + TAB_NAME + '" tab has been set up with ' + numCols + ' columns.\n\n' +
    'Import and activate the audit-log-google-sheets.workflow.json in n8n to start logging.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}
