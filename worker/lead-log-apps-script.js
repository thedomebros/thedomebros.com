// TheDomeBros lead log — Google Apps Script web app.
//
// Appends every quote-form / quick-capture lead to a Google Sheet, giving a
// free mini-CRM next to the email notifications. The Cloudflare Worker POSTs
// here after sending the lead email (see LEAD_LOG_URL in quote-form-worker.js).
//
// SETUP (one time, ~5 minutes):
//   1. Create a Google Sheet (e.g. "TheDomeBros Leads") in the business
//      Google account.
//   2. In the Sheet: Extensions → Apps Script. Delete the placeholder code
//      and paste this entire file.
//   3. Deploy → New deployment → type "Web app":
//        - Execute as: Me
//        - Who has access: Anyone
//      Click Deploy and copy the web app URL (ends in /exec).
//   4. In the Cloudflare dashboard, on the quote-form Worker, add a plain
//      variable LEAD_LOG_URL with that URL, then deploy the Worker.
//
// Columns: Date | Source | Name | Email | Phone | Pool size | Message | Status
// "Status" starts as NEW — update it by hand as you work leads
// (e.g. TEXTED, QUOTED, WON, LOST).

function doPost(e) {
  var data = JSON.parse(e.postData.contents);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Leads") || ss.insertSheet("Leads");
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["Date", "Source", "Name", "Email", "Phone", "Pool size", "Message", "Status"]);
    sheet.setFrozenRows(1);
  }
  sheet.appendRow([
    new Date(),
    data.source || "",
    data.name || "",
    data.email || "",
    data.phone || "",
    data.pool_size || "",
    data.message || "",
    "NEW",
  ]);
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
