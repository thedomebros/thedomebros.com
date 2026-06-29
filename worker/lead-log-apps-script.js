// TheDomeBros lead log — Google Apps Script web app.
//
// Appends every quote-form / quick-capture lead to a Google Sheet, giving a
// free mini-CRM next to the email notifications, and mirrors the lead into
// Google Contacts — tagged with a "Quote Lead" label so prospects are easy to
// tell apart from real customers. The Cloudflare Worker POSTs here after
// sending the lead email (see LEAD_LOG_URL in quote-form-worker.js).
//
// SETUP (one time, ~5 minutes):
//   1. Create a Google Sheet (e.g. "TheDomeBros Leads") in the business
//      Google account.
//   2. In the Sheet: Extensions → Apps Script. Delete the placeholder code
//      and paste this entire file.
//   3. Enable the People API advanced service (needed for the Contacts sync):
//      in the Apps Script editor, click "Services" (+), choose "People API",
//      keep the identifier "People", and click Add.
//   4. Deploy → New deployment → type "Web app":
//        - Execute as: Me
//        - Who has access: Anyone
//      Click Deploy. The first deploy will prompt you to authorize the
//      Contacts (and Sheets) permissions — accept them. Copy the web app URL
//      (ends in /exec).
//   5. In the Cloudflare dashboard, on the quote-form Worker, add a plain
//      variable LEAD_LOG_URL with that URL, then deploy the Worker.
//
// NOTE: when you change this code later, re-deploy with "Manage deployments →
// edit → New version" so the live /exec URL keeps working. If you add or
// change scopes, Apps Script will prompt you to re-authorize.
//
// Columns: Date | Source | Name | Email | Phone | Pool size | Zip | Message | Status | Texts OK?
// "Status" starts as NEW — update it by hand as you work leads
// (e.g. TEXTED, QUOTED, WON, LOST).

function doPost(e) {
  var data = JSON.parse(e.postData.contents);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Leads") || ss.insertSheet("Leads");
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["Date", "Source", "Name", "Email", "Phone", "Pool size", "Zip", "Message", "Status", "Texts OK?"]);
    sheet.setFrozenRows(1);
  }
  // SMS consent: only meaningful when we have a phone number to text.
  var textsOk = data.phone ? (data.sms_consent === "yes" ? "YES" : "NO") : "";
  sheet.appendRow([
    new Date(),
    data.source || "",
    data.name || "",
    data.email || "",
    data.phone || "",
    data.pool_size || "",
    data.zip || "",
    data.message || "",
    "NEW",
    textsOk,
  ]);

  // Mirror the lead into Google Contacts. Never let a Contacts failure break
  // lead logging — the Sheet row above is what must succeed.
  try {
    upsertContact(data);
  } catch (err) {
    console.error("Contact sync failed: " + err);
  }

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Google Contacts label applied to every quote lead, so prospects are easy to
// tell apart from real customers. Rename here to change the tag.
var QUOTE_LEAD_LABEL = "Quote Lead";

// Create a Google Contact for a lead, unless one with the same email or phone
// already exists, then tag it with QUOTE_LEAD_LABEL. Requires the People API
// advanced service (identifier "People") and the contacts scope (granted on
// first deploy).
function upsertContact(data) {
  var name = (data.name || "").trim();
  var email = (data.email || "").trim();
  var phone = (data.phone || "").trim();

  // No reachable channel — nothing worth saving.
  if (!email && !phone) return;

  // Dedupe: skip if a contact with this email or phone already exists.
  if (findExistingContact(email, phone)) return;

  var resource = {};
  // Quick leads submit no name. Give them a dated placeholder ("Quick Lead
  // 6/25/26") so an incoming call shows recognizable caller ID instead of a
  // bare number.
  if (name) {
    resource.names = [{ givenName: name }];
  } else {
    var dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "M/d/yy");
    resource.names = [{ givenName: "Quick Lead " + dateStr }];
  }
  if (email) resource.emailAddresses = [{ value: email }];
  if (phone) resource.phoneNumbers = [{ value: phone }];

  // A short note ties the contact back to the quote that created it.
  var note = [];
  if (data.pool_size) note.push("Pool size: " + data.pool_size);
  if (data.zip) note.push("Zip: " + data.zip);
  if (data.source) note.push("Source: " + data.source);
  // Record SMS consent so it's visible on the contact (compliance evidence).
  if (phone) note.push(data.sms_consent === "yes" ? "Texts: OPTED IN (form)" : "Texts: NOT opted in — get consent first");
  if (data.message) note.push("Message: " + data.message);
  note.push("Added from quote form on " + new Date().toDateString());
  resource.biographies = [{ value: note.join("\n"), contentType: "TEXT_PLAIN" }];

  var created = People.People.createContact(resource);

  // Tag the new contact with the "Quote Lead" label so it's filterable in
  // Google Contacts and clearly not a customer yet.
  People.ContactGroups.Members.modify(
    { resourceNamesToAdd: [created.resourceName] },
    getQuoteLeadLabel()
  );
}

// Return the resourceName of the QUOTE_LEAD_LABEL contact group, creating the
// label once if it doesn't exist yet.
function getQuoteLeadLabel() {
  var res = People.ContactGroups.list({ pageSize: 1000 });
  var groups = (res && res.contactGroups) || [];
  for (var i = 0; i < groups.length; i++) {
    if (groups[i].name === QUOTE_LEAD_LABEL) return groups[i].resourceName;
  }
  var created = People.ContactGroups.create({ contactGroup: { name: QUOTE_LEAD_LABEL } });
  return created.resourceName;
}

// Best-effort dedupe via the People search API. Email matching is reliable;
// phone matching depends on how an existing number is formatted, so a repeat
// phone-only lead may occasionally slip through — acceptable for the volume.
function findExistingContact(email, phone) {
  var queries = [];
  if (email) queries.push(email);
  if (phone) queries.push(phone);
  for (var i = 0; i < queries.length; i++) {
    var res = People.People.searchContacts({
      query: queries[i],
      readMask: "emailAddresses,phoneNumbers",
    });
    if (res && res.results && res.results.length > 0) return true;
  }
  return false;
}
