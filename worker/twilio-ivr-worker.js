// TheDomeBros phone IVR — Cloudflare Worker.
//
// Powers the business phone line via Twilio. An inbound call gets a keypad menu
// (1 = new quote, 2 = existing install / seasonal service, 3 = leave a message),
// rings the team's cells, and takes a transcribed voicemail that's emailed to
// the business. Inbound texts are emailed too, with a light auto-reply.
//
// Built to mirror quote-form-worker.js (same Resend setup) so it can live in the
// public repo with no secrets in code.
//
// DEPLOY: this file is a MIRROR of what's deployed. Editing it here does NOT
// redeploy — paste it into the Cloudflare dashboard (same as the quote Worker),
// or run `wrangler deploy`.
//
// Twilio number config (in the Twilio console, both as HTTP POST):
//   Voice     → "A call comes in"    → Webhook → https://<worker-url>/voice
//   Messaging → "A message comes in" → Webhook → https://<worker-url>/sms
//
// Worker config (set in the Cloudflare dashboard, NEVER hardcoded):
//   Var    SALES_CELLS    : comma-separated E.164 cells to ring (rings all at once),
//                           e.g. "+13852044760,+1801XXXXXXX"
//   Secret RESEND_API_KEY : Resend API key (the same one the quote Worker uses)
//   Var    MAIL_FROM      : verified sender, e.g. "TheDomeBros <quotes@thedomebros.com>"
//   Var    LEAD_TO        : inbox that receives voicemails and inbound texts
//
// TODO before going live: validate the X-Twilio-Signature header so only Twilio
// can hit these routes. Not yet implemented.

const VOICE = "Polly.Joanna";

function twiml(body) {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`,
    { headers: { "Content-Type": "text/xml; charset=UTF-8" } }
  );
}

const say = (text) => `<Say voice="${VOICE}">${text}</Say>`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

async function sendEmail(apiKey, payload) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    const origin = u.origin;
    const path = u.pathname.replace(/\/+$/, "") || "/";

    // Inbound CALL → keypad menu.
    if (path === "/voice") {
      return twiml(
        `<Gather numDigits="1" action="/voice/route" method="POST" timeout="6">` +
          say(
            "Thanks for calling The Dome <phoneme alphabet=\"ipa\" ph=\"broʊz\">Bros</phoneme>. For a new pool dome quote, press 1. " +
            "For an existing install or seasonal service, press 2. To leave a message, press 3."
          ) +
        `</Gather>` +
        // No input → repeat the menu once.
        `<Redirect method="POST">/voice</Redirect>`
      );
    }

    // Route the keypress.
    if (path === "/voice/route") {
      const digit = ((await request.formData()).get("Digits") || "").toString();

      if (digit === "1" || digit === "2") {
        const cells = (env.SALES_CELLS || "")
          .split(",").map((s) => s.trim()).filter(Boolean);
        if (cells.length === 0) {
          return twiml(
            say("Sorry, no one is available right now.") +
            `<Redirect method="POST">/voice/voicemail</Redirect>`
          );
        }
        // The whisper URL on <Number> must be absolute (relative breaks the dial).
        const numbers = cells.map((n) => `<Number url="${origin}/voice/whisper">${n}</Number>`).join("");
        // After the dial, /voice/after-dial decides: hang up vs. voicemail.
        return twiml(
          say("Connecting you now. One moment.") +
          `<Dial timeout="20" action="/voice/after-dial" method="POST">${numbers}</Dial>`
        );
      }

      // 3 (or anything else) → voicemail.
      return twiml(`<Redirect method="POST">/voice/voicemail</Redirect>`);
    }

    // Whisper / screen: the team member must press a key to accept. If a personal
    // cell voicemail answers instead, it won't press a key, the leg hangs up, and
    // the caller is NEVER bridged to that personal greeting.
    if (path === "/voice/whisper") {
      return twiml(
        `<Gather numDigits="1" timeout="8" action="${origin}/voice/whisper-accept" method="POST">` +
          say("You have a call on your business line. Press any key to take it.") +
        `</Gather>` +
        // No key (e.g. voicemail answered) → drop this leg without bridging.
        `<Hangup/>`
      );
    }

    // A key was pressed → accept. Finishing this TwiML bridges the caller in.
    if (path === "/voice/whisper-accept") {
      return twiml(say("Connecting you now."));
    }

    // After the dial: hang up if a person actually took the call; otherwise send
    // the caller to the business voicemail.
    if (path === "/voice/after-dial") {
      const status = ((await request.formData()).get("DialCallStatus") || "").toString();
      if (status === "completed") return twiml(`<Hangup/>`);
      return twiml(`<Redirect method="POST">/voice/voicemail</Redirect>`);
    }

    // Voicemail prompt + record.
    if (path === "/voice/voicemail") {
      return twiml(
        say("Sorry we missed you. Leave a message after the beep, then press pound or just hang up.") +
        `<Record maxLength="120" timeout="5" finishOnKey="#" playBeep="true" ` +
                `transcribe="true" transcribeCallback="${origin}/voice/vm-done" ` +
                `action="${origin}/voice/vm-hangup" method="POST" />`
      );
    }

    // Caller finished the recording.
    if (path === "/voice/vm-hangup") {
      return twiml(say("Thanks. We'll get back to you soon. Goodbye.") + `<Hangup/>`);
    }

    // Transcription ready → email it to the business.
    if (path === "/voice/vm-done") {
      const form = await request.formData();
      const from = (form.get("From") || "unknown").toString();
      const recordingUrl = (form.get("RecordingUrl") || "").toString();
      const transcript = (form.get("TranscriptionText") || "(transcription unavailable)").toString();

      if (env.RESEND_API_KEY && env.MAIL_FROM && env.LEAD_TO) {
        ctx.waitUntil(sendEmail(env.RESEND_API_KEY, {
          from: env.MAIL_FROM,
          to: [env.LEAD_TO],
          ...(from.startsWith("+") ? { reply_to: from } : {}),
          subject: `New voicemail from ${from}`,
          html:
            `<h2>New voicemail</h2>` +
            `<p><strong>From:</strong> ${escapeHtml(from)}</p>` +
            `<p><strong>Transcript:</strong><br>${escapeHtml(transcript).replace(/\n/g, "<br>")}</p>` +
            (recordingUrl ? `<p><a href="${escapeHtml(recordingUrl)}.mp3">Listen to the recording</a></p>` : ""),
        }).catch(() => {}));
      }
      return new Response("ok"); // Twilio ignores the body of a transcribe callback.
    }

    // Inbound SMS → email it to the business + light auto-reply.
    if (path === "/sms") {
      const form = await request.formData();
      const from = (form.get("From") || "unknown").toString();
      const body = (form.get("Body") || "").toString();

      if (env.RESEND_API_KEY && env.MAIL_FROM && env.LEAD_TO) {
        ctx.waitUntil(sendEmail(env.RESEND_API_KEY, {
          from: env.MAIL_FROM,
          to: [env.LEAD_TO],
          ...(from.startsWith("+") ? { reply_to: from } : {}),
          subject: `New text from ${from}`,
          html: `<p><strong>${escapeHtml(from)}</strong> texted:</p><p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>`,
        }).catch(() => {}));
      }
      // Auto-reply. Delete this <Message> if you'd rather not reply automatically.
      return twiml(
        `<Message>Thanks for texting TheDomeBros! We got your message and will reply shortly. ` +
        `For a fast quote you can also visit thedomebros.com.</Message>`
      );
    }

    return new Response("TheDomeBros IVR worker. Twilio POSTs to /voice and /sms.", { status: 200 });
  },
};
