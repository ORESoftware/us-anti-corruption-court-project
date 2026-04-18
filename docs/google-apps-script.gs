const SHEET_NAME = 'interest_signups';

function doPost(e) {
  const sheet = getOrCreateSheet_();
  const params = e && e.parameter ? e.parameter : {};

  sheet.appendRow([
    new Date(),
    params.email || '',
    params.source || '',
    params.page || '',
    params.submittedAt || '',
    params.userAgent || '',
  ]);

  return ContentService.createTextOutput(
    JSON.stringify({ ok: true })
  ).setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
    sheet.appendRow([
      'received_at',
      'email',
      'source',
      'page',
      'submitted_at',
      'user_agent',
    ]);
  }

  return sheet;
}
