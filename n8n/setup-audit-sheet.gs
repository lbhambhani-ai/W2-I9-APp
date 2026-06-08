/**
 * Onboarding Audit Log — Google Sheets Setup
 * ============================================
 * Run this script once from inside your Google Sheet to:
 *   1. Create (or reset) the "audit_log" tab
 *   2. Write all 16 column headers (matches the n8n Normalize node output)
 *   3. Apply color-coded section backgrounds
 *   4. Bold + center-align headers, freeze row 1
 *   5. Set column widths
 *   6. Add alternating row banding
 *   7. Add a thick bottom border under the header row
 *
 * HOW TO RUN:
 *   1. Open your Google Sheet:
 *      https://docs.google.com/spreadsheets/d/19MM98YCU_Qtpz8YEXL6l6cHlQgVMNMAsbcDkA99e524/edit
 *   2. Click Extensions → Apps Script
 *   3. Paste this entire file into the editor (replace any existing code)
 *   4. Click ▶ Run → select "setupAuditLog"
 *   5. Authorize when prompted (it only needs access to this sheet)
 *   6. Done — close the Apps Script tab and refresh your sheet
 *
 * Safe to re-run: it clears and rebuilds the header row without touching data rows.
 */

// Target spreadsheet. Used so this works as a STANDALONE Apps Script project
// (script.google.com) as well as one bound to the sheet.
var AUDIT_SHEET_SPREADSHEET_ID = "19MM98YCU_Qtpz8YEXL6l6cHlQgVMNMAsbcDkA99e524";
var TAB_NAME = "audit_log";

// ── Column definitions ────────────────────────────────────────────────────────
// Format: [header label, width in pixels, background hex color]
// Colors group columns by section for easy reading.
// One row per event, 16 columns, matching the n8n "Normalize Audit Row" output exactly.
var COLUMNS = [
  // Section: Session / Meta — blue-grey
  ["Timestamp",            180, "#BDD7EE"],
  ["Event",                150, "#BDD7EE"],
  ["Session ID",           220, "#BDD7EE"],

  // Section: User (name + email only) — light green
  ["Name",                 200, "#C6EFCE"],
  ["Email",                240, "#C6EFCE"],

  // Section: Attempt / Document — light yellow
  ["Flow",                 100, "#FFEB9C"],
  ["Attempt #",             80, "#FFEB9C"],
  ["Result",               150, "#FFEB9C"],
  ["Document",             220, "#FFEB9C"],

  // Section: AWS S3 file — light purple
  ["File Name",            200, "#E2CFFF"],
  ["AWS File Location",    320, "#E2CFFF"],
  ["AWS File URL",         360, "#E2CFFF"],

  // Section: Status / Detail — light orange
  ["Immigration Status",   180, "#FCE4D6"],
  ["Details",              420, "#FCE4D6"],

  // Section: Intercom — light lavender
  ["Intercom User ID",     160, "#EAD1DC"],
  ["Intercom Ticket ID",   150, "#EAD1DC"]
];

// ── Main function — run this ──────────────────────────────────────────────────
function setupAuditLog() {
  // openById works in both standalone and bound projects; fall back to the active
  // spreadsheet when this script is bound to the sheet directly.
  var ss = AUDIT_SHEET_SPREADSHEET_ID
    ? SpreadsheetApp.openById(AUDIT_SHEET_SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
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

  // ── 10. Make AWS File URL column show clickable links ────────────────────
  // Column 12 = "AWS File URL" — format as plain text (links auto-detect)
  sheet.getRange(2, 12, 1000, 1).setWrap(false);

  Logger.log('✅ Audit log sheet setup complete!');
  Logger.log('Columns: ' + numCols);
  Logger.log('Open: https://docs.google.com/spreadsheets/d/19MM98YCU_Qtpz8YEXL6l6cHlQgVMNMAsbcDkA99e524/edit');

  // Show a popup confirmation when bound to the sheet. getUi() is unavailable in a
  // standalone project, so guard it — the Logger output above is the source of truth.
  try {
    SpreadsheetApp.getUi().alert(
      '✅ Audit Log Setup Complete',
      'The "' + TAB_NAME + '" tab has been set up with ' + numCols + ' columns.\n\n' +
      'Import and activate the audit-log-google-sheets.workflow.json in n8n to start logging.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
  } catch (e) {
    Logger.log('(Standalone project — skipping UI alert.)');
  }
}
