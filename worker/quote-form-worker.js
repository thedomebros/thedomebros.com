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

export default {
  async fetch(request, env) {
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

    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ success: false, message: "Invalid form data" }, 400, origin);
    }

    // Honeypot: a bot fills the hidden "botcheck" field. Pretend success.
    if ((form.get("botcheck") || "").toString().trim() !== "") {
      return json({ success: true }, 200, origin);
    }

    const name = (form.get("name") || "").toString().trim();
    const email = (form.get("email") || "").toString().trim();
    const phone = (form.get("phone") || "").toString().trim();
    const poolSize = (form.get("pool_size") || "").toString().trim();
    const message = (form.get("message") || "").toString().trim();
    const _src = (form.get("source") || "").toString().trim().toLowerCase();
    const source = /^[a-z-]{1,20}$/.test(_src) ? _src : "site";

    // Quick-capture forms (source "quick-*") submit only an email address;
    // every other form still requires the full set of fields.
    const isQuick = source.startsWith("quick");
    if (!email || (!isQuick && (!name || !poolSize || !message))) {
      return json({ success: false, message: "Please fill in all fields." }, 400, origin);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ success: false, message: "Please enter a valid email." }, 400, origin);
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
      ? { Email: email }
      : { Name: name, Email: email, Phone: phone, "Pool size": poolSize, Message: message };
    const leadHtml = Object.entries(rows)
      .map(([k, v]) => `<p><strong>${k}:</strong><br>${escapeHtml(v).replace(/\n/g, "<br>")}</p>`)
      .join("");
    const fileNote = attachments.length
      ? `<p><strong>Attachments:</strong> ${attachments.length} file(s)</p>`
      : "";

    try {
      // 1) Lead to the business (includes any uploaded files).
      await sendEmail(env.RESEND_API_KEY, {
        from: env.MAIL_FROM,
        to: [env.LEAD_TO],
        reply_to: email,
        subject: isQuick
          ? `New quick lead (${source}) — ${email}`
          : `New quote request (${source}) — ${name}`,
        html: `<h2>New quote request from thedomebros.com</h2><p><strong>Source:</strong> ${source}</p>${leadHtml}${fileNote}`,
        ...(attachments.length ? { attachments } : {}),
      });

      // 2) Auto-reply to the submitter (no attachments).
      await sendEmail(env.RESEND_API_KEY, {
        from: env.MAIL_FROM,
        to: [email],
        subject: "We received your quote request — TheDomeBros",
        html: isQuick
          ? `<p>Hi,</p>` +
            `<p>Thanks for requesting a free quote from TheDomeBros — we'll reach out shortly.</p>` +
            `<p><strong>Want a faster, more accurate quote?</strong> Just reply to this email with ` +
            `your approximate pool size (width &times; length) and a photo or two of your pool and ` +
            `the concrete deck around it.</p>` +
            `<p>— TheDomeBros</p>`
          : `<p>Hi ${escapeHtml(name)},</p>` +
            `<p>Thanks for reaching out to TheDomeBros. We've received your quote ` +
            `request and will review your pool details and get back to you soon.</p>` +
            `<p><strong>What you sent us:</strong></p>${leadHtml}${fileNote}` +
            `<p>— TheDomeBros</p>`,
      });
    } catch (err) {
      return json({ success: false, message: "Could not send. Please email us directly." }, 502, origin);
    }

    return json({ success: true }, 200, origin);
  },
};
