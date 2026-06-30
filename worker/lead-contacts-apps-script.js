// TheDomeBros lead → Google Contacts sync — standalone Google Apps Script web app.
//
// Apps Script project 1cWFW6-MkZXc_fA75nnHzxhgd4Bg-XzMEFRYgc0TR719j0BtjcvAKI8kH
// To edit/deploy: clasp clone-script 1cWFW6-MkZXc_fA75nnHzxhgd4Bg-XzMEFRYgc0TR719j0BtjcvAKI8kH
//
// Mirrors every quote-form / quick-capture lead into Google Contacts — tagged
// with a "Quote Lead" label so prospects are easy to tell apart from real
// customers, and so an incoming call/text to the business line shows a
// recognizable name instead of a bare number. The Cloudflare Worker POSTs here
// after sending the lead email (see LEAD_LOG_URL in quote-form-worker.js).
//
// This is the standalone successor to the spreadsheet-bound lead-log script:
// lead capture/CRM now lives in Streak, so this project keeps only the Contacts
// sync and writes to no sheet.
//
// SETUP:
//   1. Deploy → New deployment → type "Web app":
//        - Execute as: Me
//        - Who has access: Anyone
//      Then authorize the Contacts permission when prompted. Copy the web app
//      URL (ends in /exec).
//   2. In the Cloudflare dashboard, on the quote-form Worker, set the plain
//      variable LEAD_LOG_URL to that URL, then deploy the Worker.
//
// NOTE: when you change this code later, re-deploy with "Manage deployments →
// edit → New version" (or clasp redeploy) so the live /exec URL keeps working.

function doPost(e) {
  var data = JSON.parse(e.postData.contents);

  try {
    if (data.source === "messaging") upsertFromMessaging(data);
    else upsertContact(data);
  } catch (err) {
    console.error("Contact sync failed: " + err);
  }

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Run this once from the editor after creating the project to grant the
// Contacts permission, so the deployed web app (which runs as you) is
// authorized.
function authorizeContacts() {
  getQuoteLeadLabel();
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

  // Phone-only lead: synthesize a no-inbox sentinel email so the contact can be
  // added as a Google Calendar guest (Calendar requires an email) and still
  // autocompletes by name. The calendar reminder script recognizes this address
  // and texts the customer instead of emailing it. See phoneFromSentinel() in
  // the calendar script — format must stay <e164-digits>@sms.thedomebros.com.
  if (phone && !email) {
    var sentinel = sentinelEmail(phone);
    if (sentinel) email = sentinel;
  }

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

// Build the no-inbox sentinel email for a phone-only lead. Returns
// <e164-digits>@sms.thedomebros.com (no leading '+', so the local part stays a
// valid email). The calendar reminder script strips this back to E.164 to match
// the stored contact and text the customer. Returns null if the number can't be
// normalized (don't invent a bogus email).
function sentinelEmail(phone) {
  var d = String(phone || "").replace(/\D/g, "");
  if (d.length === 10) d = "1" + d;
  else if (d.length === 11 && d.charAt(0) === "1") { /* already 1 + 10 digits */ }
  else if (String(phone).charAt(0) === "+" && d.length >= 11 && d.length <= 15) { /* keep full intl digits */ }
  else return null;
  return d + "@sms.thedomebros.com";
}

// One-time backfill: walk existing "Quote Lead" contacts and add the sentinel
// email to any that have a phone but no email, so they can be added as calendar
// guests. Safe to re-run — it skips contacts that already have an email. Run
// once from the editor after deploying this version.
function backfillPhoneOnlyEmails() {
  var label = getQuoteLeadLabel();
  var grp = People.ContactGroups.get(label, { maxMembers: 1000 });
  var names = (grp && grp.memberResourceNames) || [];
  var updated = 0, skipped = 0;
  for (var i = 0; i < names.length; i += 200) {
    var batch = names.slice(i, i + 200);
    var res = People.People.getBatchGet({
      resourceNames: batch,
      personFields: "names,emailAddresses,phoneNumbers",
    });
    var responses = (res && res.responses) || [];
    for (var j = 0; j < responses.length; j++) {
      var p = responses[j].person;
      if (!p) continue;
      var hasEmail = p.emailAddresses && p.emailAddresses.length > 0;
      var hasPhone = p.phoneNumbers && p.phoneNumbers.length > 0;
      if (hasEmail || !hasPhone) { skipped++; continue; }
      var sentinel = sentinelEmail(p.phoneNumbers[0].value);
      if (!sentinel) { skipped++; continue; }
      p.emailAddresses = [{ value: sentinel }];
      People.People.updateContact(p, p.resourceName, { updatePersonFields: "emailAddresses" });
      updated++;
    }
  }
  console.log("Backfill complete: " + updated + " updated, " + skipped + " skipped.");
  return "updated " + updated + ", skipped " + skipped;
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

// Return the first matching person resource (with etag + fields) for an
// email/phone, or null. Used to update an existing contact in place.
function findContactResource(email, phone) {
  var queries = [];
  if (email) queries.push(email);
  if (phone) queries.push(phone);
  for (var i = 0; i < queries.length; i++) {
    var res = People.People.searchContacts({
      query: queries[i],
      readMask: "names,emailAddresses,phoneNumbers",
    });
    if (res && res.results && res.results.length > 0) return res.results[0].person;
  }
  return null;
}

// Save a contact initiated from the messaging app: create a Google Contact (or
// add a name/email to an existing one). Unlike upsertContact, these are people
// you're actively texting — customers, not raw leads — so no "Quote Lead" label.
function upsertFromMessaging(data) {
  var name = (data.name || "").trim();
  var email = (data.email || "").trim();
  var phone = (data.phone || "").trim();
  if (!phone && !email) return;

  var p = findContactResource(email, phone);
  if (p) {
    var upd = { etag: p.etag };
    var fields = [];
    if (name) { upd.names = [{ givenName: name }]; fields.push("names"); }
    if (email && !(p.emailAddresses && p.emailAddresses.length)) { upd.emailAddresses = [{ value: email }]; fields.push("emailAddresses"); }
    if (fields.length) People.People.updateContact(upd, p.resourceName, { updatePersonFields: fields.join(",") });
    return;
  }

  var resource = { names: [{ givenName: name || phone }] };
  if (email) resource.emailAddresses = [{ value: email }];
  if (phone) resource.phoneNumbers = [{ value: phone }];
  resource.biographies = [{ value: "Added from TheDomeBros messaging on " + new Date().toDateString(), contentType: "TEXT_PLAIN" }];
  People.People.createContact(resource);
}
