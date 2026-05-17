// TheDomeBros quote-form handler — Cloudflare Worker.
//
// Receives the quote form POST from the static site, emails the lead to the
// business, and sends an auto-reply to the submitter via the Resend API.
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

    if (!name || !email || !phone || !poolSize || !message) {
      return json({ success: false, message: "Please fill in all fields." }, 400, origin);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ success: false, message: "Please enter a valid email." }, 400, origin);
    }

    const rows = { Name: name, Email: email, Phone: phone, "Pool size": poolSize, Message: message };
    const leadHtml = Object.entries(rows)
      .map(([k, v]) => `<p><strong>${k}:</strong><br>${escapeHtml(v).replace(/\n/g, "<br>")}</p>`)
      .join("");

    try {
      // 1) Lead to the business.
      await sendEmail(env.RESEND_API_KEY, {
        from: env.MAIL_FROM,
        to: [env.LEAD_TO],
        reply_to: email,
        subject: `New quote request — ${name}`,
        html: `<h2>New quote request from thedomebros.com</h2>${leadHtml}`,
      });

      // 2) Auto-reply to the submitter.
      await sendEmail(env.RESEND_API_KEY, {
        from: env.MAIL_FROM,
        to: [email],
        subject: "We received your quote request — TheDomeBros",
        html:
          `<p>Hi ${escapeHtml(name)},</p>` +
          `<p>Thanks for reaching out to TheDomeBros. We've received your quote ` +
          `request and will review your pool details and get back to you soon.</p>` +
          `<p><strong>What you sent us:</strong></p>${leadHtml}` +
          `<p>— TheDomeBros</p>`,
      });
    } catch (err) {
      return json({ success: false, message: "Could not send. Please email us directly." }, 502, origin);
    }

    return json({ success: true }, 200, origin);
  },
};
