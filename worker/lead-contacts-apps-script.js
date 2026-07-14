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

  // Quick leads submit no name. An email-only lead is titled by its email — it
  // identifies the person, and with no phone they can never call in. A
  // phone-only lead gets a dated placeholder ("Quick Lead 6/25/26") so an
  // incoming call shows recognizable caller ID instead of a bare number.
  // (Must run BEFORE the sentinel below so the title is never the fake email.)
  if (!name) {
    var dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "M/d/yy");
    name = email || ("Quick Lead " + dateStr);
  }

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
  resource.names = [{ givenName: name }];
  if (email) resource.emailAddresses = [{ value: email }];
  if (phone) resource.phoneNumbers = [{ value: phone }];

  // A short note ties the contact back to the quote that created it.
  var note = [];
  if (data.pool_size) note.push("Pool size: " + data.pool_size);
  var addr = data.address || data.zip; // older worker deploys send "zip"
  if (addr) note.push("Address: " + addr);
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

  var resourceName;
  var p = findContactResource(email, phone);
  if (p) {
    var upd = { etag: p.etag };
    var fields = [];
    if (name) { upd.names = [{ givenName: name }]; fields.push("names"); }
    if (email && !(p.emailAddresses && p.emailAddresses.length)) { upd.emailAddresses = [{ value: email }]; fields.push("emailAddresses"); }
    if (fields.length) People.People.updateContact(upd, p.resourceName, { updatePersonFields: fields.join(",") });
    resourceName = p.resourceName;
  } else {
    var resource = { names: [{ givenName: name || phone }] };
    if (email) resource.emailAddresses = [{ value: email }];
    if (phone) resource.phoneNumbers = [{ value: phone }];
    resource.biographies = [{ value: "Added from TheDomeBros messaging on " + new Date().toDateString(), contentType: "TEXT_PLAIN" }];
    resourceName = People.People.createContact(resource).resourceName;
  }

  // Optionally tag as a quote lead (same label the lead pipeline uses).
  if (data.quote_lead && resourceName) {
    People.ContactGroups.Members.modify({ resourceNamesToAdd: [resourceName] }, getQuoteLeadLabel());
  }
}

// ---- One-time: push every "Quote Lead" Google Contact into the messaging app ----
// Run from the editor (Run > backfillLeadsToApp). Approve the permission prompt
// on first run (it adds the external-request scope). Safe to re-run — the app
// dedupes by phone/email.
var MSG_INGEST = "https://messaging.thedomebros-com.workers.dev/api/ingest";
var MSG_INGEST_SECRET = "REPLACE_WITH_INGEST_SECRET";

function backfillLeadsToApp() {
  var label = getQuoteLeadLabel();
  var grp = People.ContactGroups.get(label, { maxMembers: 1000 });
  var names = (grp && grp.memberResourceNames) || [];
  var sent = 0, skipped = 0;
  for (var i = 0; i < names.length; i += 200) {
    var res = People.People.getBatchGet({
      resourceNames: names.slice(i, i + 200),
      personFields: "names,emailAddresses,phoneNumbers",
    });
    var rs = (res && res.responses) || [];
    for (var j = 0; j < rs.length; j++) {
      var p = rs[j].person; if (!p) continue;
      var nm = (p.names && p.names[0] && p.names[0].displayName) || "";
      var ph = (p.phoneNumbers && p.phoneNumbers[0] && p.phoneNumbers[0].value) || "";
      var em = (p.emailAddresses && p.emailAddresses[0] && p.emailAddresses[0].value) || "";
      // sentinel emails are app-generated, not a real reachable address
      if (/@sms\.thedomebros\.com$/i.test(em)) em = "";
      if (!ph && !em) { skipped++; continue; }
      var r = UrlFetchApp.fetch(MSG_INGEST, {
        method: "post", contentType: "application/json", muteHttpExceptions: true,
        headers: { "X-Ingest-Secret": MSG_INGEST_SECRET },
        payload: JSON.stringify({ name: nm, phone: ph, email: em, source: "gcontacts" }),
      });
      if (r.getResponseCode() === 200) sent++; else { skipped++; console.log("failed:", nm, r.getResponseCode(), r.getContentText()); }
    }
  }
  console.log("Backfill done: " + sent + " sent, " + skipped + " skipped.");
  return "sent " + sent + ", skipped " + skipped;
}

// ---- One-time: pull past quote emails (message + attachments) into the app ----
// Reads the lead emails in this Gmail account and posts each into the
// customer's thread via /api/ingest-quote (original date preserved). Threads
// get the "app-backfilled" Gmail label so re-runs skip them. Run from the
// editor; approve the Gmail permission on first run.
function backfillQuoteThreads() {
  var q = 'subject:("New quote request" OR "New quick lead") -label:app-backfilled';
  var threads = GmailApp.search(q, 0, 100);
  var label = GmailApp.getUserLabelByName("app-backfilled") || GmailApp.createLabel("app-backfilled");
  var sent = 0, skipped = 0;
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      var subj = m.getSubject() || "";
      if (!/New (quote request|quick lead)/.test(subj)) return;
      var body = m.getPlainBody() || "";
      function grab(lbl) { var mm = body.match(new RegExp(lbl + ":\\s*\\n?([^\\n]*)")); return mm ? mm[1].trim() : ""; }
      var name = grab("Name"), email = grab("Email"), phone = grab("Phone");
      var pool = grab("Pool size"), addr = grab("Address") || grab("Zip");
      var msgTxt = "";
      var mi = body.indexOf("Message:");
      if (mi > -1) msgTxt = body.slice(mi + 8).split(/\nTexts OK\?|\nAttachments:/)[0].trim();
      var src = (subj.match(/\(([^)]+)\)/) || [])[1] || "site";
      if (!email && !phone) { skipped++; return; }
      var payload = { phone: phone, email: email, name: name, source: src, pool_size: pool, address: addr, message: msgTxt, at: m.getDate().toISOString() };
      var atts = m.getAttachments({ includeInlineImages: false, includeAttachments: true });
      for (var i = 0; i < atts.length; i++) payload["attachment" + i] = atts[i].copyBlob();
      var r = UrlFetchApp.fetch(MSG_INGEST.replace("/api/ingest", "/api/ingest-quote"), {
        method: "post", headers: { "X-Ingest-Secret": MSG_INGEST_SECRET },
        payload: payload, muteHttpExceptions: true,
      });
      if (r.getResponseCode() === 200) sent++;
      else { skipped++; console.log("failed:", subj, r.getResponseCode(), r.getContentText().slice(0, 150)); }
    });
    t.addLabel(label);
  });
  console.log("Quote backfill: " + sent + " sent, " + skipped + " skipped.");
  return "sent " + sent + ", skipped " + skipped;
}
