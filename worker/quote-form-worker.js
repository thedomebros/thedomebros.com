// TheDomeBros quote-form handler — Cloudflare Worker.
//
// Receives the quote form POST from the static site, emails the lead to the
// business (with any uploaded files attached), and sends an auto-reply to the
// submitter via the Resend API.
//
// Required Worker configuration (set in the Cloudflare dashboard, NOT in code):
//   - Secret  RESEND_API_KEY : your Resend API key
//   - Var     LEAD_TO        : inbox that receives quote requests (e.g. you@gmail.com)
//   - Var     MAIL_FROM      : verified sender on your Resend domain
//                              (e.g. "TheDomeBros <quotes@thedomebros.com>")
//
// Addresses are intentionally not hardcoded so this file can live in the
// public repo without exposing them.

const ALLOWED_ORIGINS = [
  "https://thedomebros.com",
  "https://www.thedomebros.com",
];

// Attachment limits. Resend caps a message at 40MB AFTER base64 encoding;
// base64 inflates ~37%, so we keep raw uploads well under that for headroom.
const MAX_FILES = 6;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB total across all files

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Branded shell for customer-facing emails (matches the site's design system).
// Table-based with inline styles for email-client compatibility; the logo is
// loaded from the live site.
function brandEmail(inner) {
  return (
    `<!doctype html><html><body style="margin:0;padding:0;background:#f6f4ef;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ef;padding:28px 0;">` +
    `<tr><td align="center">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;max-width:94%;background:#fffdf8;border:1px solid #e4ddcf;border-radius:16px;">` +
    `<tr><td style="padding:24px 32px 18px;border-bottom:1px solid #e4ddcf;" align="left">` +
    `<a href="https://thedomebros.com" style="text-decoration:none;">` +
    `<img src="https://thedomebros.com/assets/logo.png" alt="TheDomeBros" width="150" style="display:block;border:0;max-width:150px;height:auto;"></a>` +
    `</td></tr>` +
    `<tr><td style="padding:26px 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7;color:#1f2a37;">` +
    inner +
    `</td></tr>` +
    `<tr><td style="padding:16px 32px 20px;border-top:1px solid #e4ddcf;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.8;color:#5b6675;">` +
    `TheDomeBros LLC &middot; Cedar Hills, Utah &middot; Serving Utah County<br>` +
    `<a href="https://thedomebros.com" style="color:#1f3b73;">thedomebros.com</a> &middot; ` +
    `<a href="mailto:contact@thedomebros.com" style="color:#1f3b73;">contact@thedomebros.com</a>` +
    `</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

// POST JSON to the messaging Worker. Goes through the MESSAGING service
// binding — Cloudflare blocks fetching another Worker on the same account via
// its workers.dev URL (error 1042) — with the public URL as a fallback when
// the binding isn't configured.
function messagingFetch(env, path, payload) {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ingest-Secret": env.MESSAGING_INGEST_SECRET },
    body: JSON.stringify(payload),
  };
  if (env.MESSAGING) return env.MESSAGING.fetch("https://messaging.internal" + path, init);
  return fetch(String(env.MESSAGING_INGEST_URL || "").replace(/\/api\/ingest\/?$/, "") + path, init);
}

async function sendEmail(apiKey, payload) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
}

// Verify a Cloudflare Turnstile token. Returns true if the visitor passed the
// bot check. A missing or rejected token returns false; if siteverify itself is
// unreachable it fails open (returns true), so a Cloudflare outage never blocks
// real leads.
async function verifyTurnstile(secret, token, ip) {
  if (!token) return false;
  const body = new URLSearchParams();
  body.append("secret", secret);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return true;
  }
}

// Handle an appointment confirmation response and email it to the business.
async function handleConfirm(request, env, origin) {
  let d;
  try { d = await request.json(); } catch { return json({ success: false, message: "Bad request" }, 400, origin); }
  const name = (d.name || "").toString().trim().slice(0, 120);
  const when = (d.when || "").toString().trim().slice(0, 120);
  const type = (d.type || "").toString().trim().slice(0, 60);
  const choice = (d.choice || "").toString().trim().toLowerCase();
  const note = (d.note || "").toString().trim().slice(0, 1000);
  const eventId = (d.eventId || "").toString().slice(0, 200);
  const LABELS = { confirmed: "Confirmed", reschedule: "Reschedule requested", canceled: "Canceled" };
  if (!LABELS[choice]) return json({ success: false, message: "Invalid choice" }, 400, origin);

  // Reflect the response on the linked Google Calendar event (best-effort).
  if (eventId && env.CALENDAR_URL && env.CALENDAR_SECRET) {
    try {
      await fetch(env.CALENDAR_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: env.CALENDAR_SECRET, action: "update", eventId, choice, note }),
      });
    } catch (e) { /* don't fail the customer's response if calendar update fails */ }
  }

  // Reflect the status in the messaging app's appointment banner (best-effort).
  if (eventId && env.MESSAGING_INGEST_SECRET) {
    try {
      const r = await messagingFetch(env, "/api/appt/status", { code: eventId, choice, note });
      console.log("appt-status push ->", r.status);
    } catch (e) { console.log("appt-status push FAILED:", String(e)); }
  }

  const noteLabel = choice === "reschedule" ? "Preferred times" : "Note";
  const html =
    `<h2>Appointment ${escapeHtml(LABELS[choice])}</h2>` +
    `<p><strong>Customer:</strong> ${escapeHtml(name || "(no name given)")}</p>` +
    `<p><strong>Type:</strong> ${escapeHtml(type || "(unspecified)")}</p>` +
    `<p><strong>When:</strong> ${escapeHtml(when || "(not specified)")}</p>` +
    (note ? `<p><strong>${noteLabel}:</strong><br>${escapeHtml(note).replace(/\n/g, "<br>")}</p>` : "");
  try {
    await sendEmail(env.RESEND_API_KEY, {
      from: env.MAIL_FROM,
      to: [env.LEAD_TO],
      subject: `${LABELS[choice]} — ${name || "a customer"}${type ? ` · ${type}` : ""}${when ? ` (${when})` : ""}`,
      html,
    });
  } catch (err) {
    return json({ success: false, message: "Could not send." }, 502, origin);
  }
  return json({ success: true }, 200, origin);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return json({ success: false, message: "Method not allowed" }, 405, origin);
    }
    if (!env.RESEND_API_KEY || !env.LEAD_TO || !env.MAIL_FROM) {
      return json({ success: false, message: "Server not configured" }, 500, origin);
    }

    // Appointment confirmation responses (from /confirm on the site) come in as
    // JSON on the /confirm path; everything else is a quote-form submission.
    if ((new URL(request.url).pathname.replace(/\/+$/, "") || "/") === "/confirm") {
      return handleConfirm(request, env, origin);
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ success: false, message: "Invalid form data" }, 400, origin);
    }

    // Honeypot: a bot fills the hidden "botcheck" field. Pretend success to
    // the client, but flag lead:false so it doesn't fire a generate_lead
    // conversion for a bot.
    if ((form.get("botcheck") || "").toString().trim() !== "") {
      return json({ success: true, lead: false }, 200, origin);
    }

    const name = (form.get("name") || "").toString().trim();
    const email = (form.get("email") || "").toString().trim();
    const phone = (form.get("phone") || "").toString().trim();
    const poolSize = (form.get("pool_size") || "").toString().trim();
    const zip = (form.get("zip") || "").toString().trim();
    const message = (form.get("message") || "").toString().trim();
    const _src = (form.get("source") || "").toString().trim().toLowerCase();
    const source = /^[a-z-]{1,20}$/.test(_src) ? _src : "site";
    // Whether the lead ticked the SMS-consent box (both forms send it via FormData).
    const smsConsent = (form.get("sms_consent") || "").toString().trim().toLowerCase() === "yes";

    // Quick-capture forms (source "quick-*") submit only an email address OR
    // a phone number; every other form still requires the full set of fields.
    const isQuick = source.startsWith("quick");
    if (isQuick) {
      const phoneDigits = phone.replace(/\D/g, "");
      if (!email && (phoneDigits.length < 10 || phoneDigits.length > 15)) {
        return json({ success: false, message: "Please enter your email or phone number." }, 400, origin);
      }
    } else if (!name || !email || !poolSize) {
      return json({ success: false, message: "Please fill in all fields." }, 400, origin);
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ success: false, message: "Please enter a valid email." }, 400, origin);
    }

    // Cloudflare Turnstile bot check. Every form fails open: a failed check
    // never rejects the lead, it just flags it unverified for review — so a
    // false positive never loses a lead, and strict rejection can be turned on
    // later if bot volume justifies it. Skipped entirely if no secret is set.
    let unverified = false;
    if (env.TURNSTILE_SECRET) {
      const turnstileOk = await verifyTurnstile(
        env.TURNSTILE_SECRET,
        (form.get("cf-turnstile-response") || "").toString(),
        request.headers.get("CF-Connecting-IP")
      );
      if (!turnstileOk) unverified = true;
    }

    // Optional file attachments (form field name "attachments", multiple).
    const files = form.getAll("attachments").filter(
      (f) => f && typeof f === "object" && "size" in f && f.size > 0 && f.name
    );
    if (files.length > MAX_FILES) {
      return json({ success: false, message: `Please attach at most ${MAX_FILES} files.` }, 400, origin);
    }
    const totalBytes = files.reduce((n, f) => n + f.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      const mb = Math.round(MAX_TOTAL_BYTES / (1024 * 1024));
      return json({ success: false, message: `Attachments total too large (max ${mb} MB).` }, 400, origin);
    }

    let attachments = [];
    try {
      attachments = await Promise.all(
        files.map(async (f) => ({
          filename: f.name,
          content: arrayBufferToBase64(await f.arrayBuffer()),
        }))
      );
    } catch {
      return json({ success: false, message: "Could not read the attached files." }, 400, origin);
    }

    const rows = isQuick
      ? Object.fromEntries([["Email", email], ["Phone", phone]].filter(([, v]) => v))
      : { Name: name, Email: email, Phone: phone, "Pool size": poolSize, Zip: zip, Message: message };
    // Surface SMS consent so you know who you can text vs. who needs verbal consent first.
    if (phone) rows["Texts OK?"] = smsConsent ? "YES — opted in on the form" : "NO — get verbal consent before texting";
    const leadHtml = Object.entries(rows)
      .map(([k, v]) => `<p><strong>${k}:</strong><br>${escapeHtml(v).replace(/\n/g, "<br>")}</p>`)
      .join("");
    const fileNote = attachments.length
      ? `<p><strong>Attachments:</strong> ${attachments.length} file(s)</p>`
      : "";

    try {
      // 1) Lead to the business (includes any uploaded files).
      // Phone-only leads get a ready-to-send text template for a fast,
      // personal first touch (send it from the Google Voice app).
      const phoneOnlyNote = isQuick && !email
        ? (smsConsent
            ? `<p><strong>Phone-only lead — opted in to texts, OK to text them.</strong> (No auto-reply was sent.)</p>` +
              `<p>Ready-to-send template (copy into Google Voice):</p>` +
              `<blockquote style="border-left:3px solid #1f3b73;margin:0;padding:8px 14px;background:#f6f4ef;">` +
              `Hi, this is Carter from TheDomeBros — saw you wanted to hear how the pool dome works. ` +
              `Happy to answer any questions! When's a good time for a quick call, or want me to just ` +
              `send the details?</blockquote>`
            : `<p><strong>Phone-only lead — did NOT opt in to texts.</strong> Call them, or get verbal consent before texting. (No auto-reply was sent.)</p>`)
        : "";
      const unverifiedNote = unverified
        ? `<p style="background:#fde2e1;border:1px solid #f5b5b2;border-radius:8px;padding:10px 14px;color:#8a1c16;"><strong>&#9888; UNVERIFIED:</strong> This lead did not pass the Turnstile bot check, but was saved anyway. Treat it with extra caution.</p>`
        : "";
      await sendEmail(env.RESEND_API_KEY, {
        from: env.MAIL_FROM,
        to: [env.LEAD_TO],
        ...(email ? { reply_to: email } : {}),
        subject: (unverified ? "[UNVERIFIED] " : "") + (isQuick
          ? `New quick lead (${source}) — ${email || phone}`
          : `New quote request (${source}) — ${name}`),
        html: `<h2>New quote request from thedomebros.com</h2>${unverifiedNote}<p><strong>Source:</strong> ${source}</p>${leadHtml}${phoneOnlyNote}${fileNote}`,
        ...(attachments.length ? { attachments } : {}),
      });

      // 2) Auto-reply to the submitter (no attachments). Two paths:
      //    quick capture ("See how it works") gets a how-it-works explainer;
      //    the full form gets the quote-request confirmation.
      //    Phone-only quick leads get no auto-reply — the business texts them.
      //    Runs in the background (waitUntil) so the visitor isn't kept
      //    waiting on a second email send; the lead email above is the one
      //    that must succeed before we report success.
      if (email) ctx.waitUntil(sendEmail(env.RESEND_API_KEY, {
        from: env.MAIL_FROM,
        to: [email],
        subject: isQuick
          ? "How a pool dome works — TheDomeBros"
          : "We received your quote request — TheDomeBros",
        html: brandEmail(isQuick
          ? `<p>Hi,</p>` +
            `<p>Thanks for your interest in TheDomeBros! We'll be in touch soon to answer any ` +
            `questions and walk you through how it all works. In the meantime, here's the short version:</p>` +
            `<ul>` +
            `<li><strong>Air-supported, no framing.</strong> A quiet blower keeps gentle positive ` +
            `pressure inside, so the vinyl dome holds its shape over your pool with no poles or ` +
            `heavy structure.</li>` +
            `<li><strong>Anchored to your deck.</strong> We measure your pool and surrounding ` +
            `concrete, then fasten the dome's perimeter to anchors set into the deck.</li>` +
            `<li><strong>Swim year-round.</strong> The dome traps warmth and blocks wind, keeping ` +
            `your outdoor pool comfortable and usable through every season. We can also take it ` +
            `down, store it, and put it back up each year.</li>` +
            `</ul>` +
            `<p><strong>Want a free, no-obligation quote?</strong> Just reply to this email with ` +
            `your approximate pool size (width &times; length) and a photo or two of your pool and ` +
            `the concrete deck around it &mdash; we respond quickly.</p>` +
            `<p>— TheDomeBros</p>`
          : `<p>Hi ${escapeHtml(name)},</p>` +
            `<p>Thanks for reaching out to TheDomeBros. We've received your quote ` +
            `request and will review your pool details and get back to you soon.</p>` +
            `<p><strong>What you sent us:</strong></p>${leadHtml}${fileNote}` +
            `<p>— TheDomeBros</p>`),
      }).catch(() => {}));
    } catch (err) {
      return json({ success: false, message: "Could not send. Please email us directly." }, 502, origin);
    }

    // Optional lead log: append the lead to a Google Sheet via an Apps Script
    // web app (see worker/lead-log-apps-script.js). Configured with the
    // LEAD_LOG_URL var in the Cloudflare dashboard; failures never block the
    // submission.
    if (env.LEAD_LOG_URL) {
      ctx.waitUntil(fetch(env.LEAD_LOG_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ source, name, email, phone, pool_size: poolSize, zip, message: unverified ? (message ? message + " " : "") + "[UNVERIFIED]" : message, sms_consent: smsConsent ? "yes" : "no" }),
      }).catch(() => {}));
    }

    // Optional: push the lead into the team messaging app so it appears as a
    // contact in the shared inbox with the right consent state. No-op until
    // MESSAGING_INGEST_URL + MESSAGING_INGEST_SECRET are set (i.e. after the
    // messaging app is deployed). Never blocks the submission.
    if (env.MESSAGING_INGEST_SECRET && phone) {
      ctx.waitUntil(messagingFetch(env, "/api/ingest", { phone, name, email, source, consent: smsConsent ? "opted_in" : "unknown" }).catch(() => {}));
    }

    return json({ success: true }, 200, origin);
  },
};
