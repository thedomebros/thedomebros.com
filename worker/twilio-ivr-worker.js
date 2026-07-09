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
// Worker config (set in the Cloudflare dashboard / via wrangler secret, NEVER hardcoded):
//   Var/Secret SALES_CELLS        : comma-separated E.164 cells, rung ONE AT A TIME
//                                   in a random order per call (sequential ring keeps
//                                   the customer's real caller ID on the cell screens)
//   Secret     RESEND_API_KEY     : Resend API key (the same one the quote Worker uses)
//   Var        MAIL_FROM          : verified sender, e.g. "TheDomeBros <quotes@thedomebros.com>"
//   Var        LEAD_TO            : inbox that receives voicemails and inbound texts
//   Secret     VM_SECRET          : shared secret for the messaging-app handoff
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

// One step of the sequential ring: dial cell i with the whisper screen; the
// Dial's action advances to i+1 (or voicemail) unless the call was taken. No
// callerId attribute — the customer's real number passes through to the cell.
function dialStep(origin, order, i) {
  const next = `/voice/seq?order=${encodeURIComponent(order.join(","))}&i=${i + 1}`;
  return (
    `<Dial timeout="15" action="${next.replace(/&/g, "&amp;")}" method="POST">` +
    `<Number url="${origin}/voice/whisper">${order[i]}</Number></Dial>`
  );
}

export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    const origin = u.origin;
    const path = u.pathname.replace(/\/+$/, "") || "/";

    // Inbound CALL → keypad menu.
    const MENU =
      `<Gather numDigits="1" action="/voice/route" method="POST" timeout="6">` +
        say(
          "Thanks for calling The Dome <phoneme alphabet=\"ipa\" ph=\"broʊz\">Bros</phoneme>. For a new pool dome quote, press 1. " +
          "For an existing install or seasonal service, press 2. To leave a message, press 3."
        ) +
      `</Gather>` +
      // No input → repeat the menu once.
      `<Redirect method="POST">/voice</Redirect>`;

    if (path === "/voice") {
      // Team call-through: when one of OUR cells calls the business line, offer
      // dial-out instead of the customer menu — the outbound call then shows the
      // business number as caller ID. Press 0# for the normal menu.
      const from = ((await request.formData()).get("From") || "").toString();
      const cells = (env.SALES_CELLS || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (from && cells.includes(from)) {
        return twiml(
          `<Gather finishOnKey="#" timeout="12" action="/voice/dialout" method="POST">` +
            say("Business line. Enter the number to call, then press pound. Or zero pound for the menu.") +
          `</Gather>` +
          `<Redirect method="POST">/voice</Redirect>`
        );
      }
      return twiml(MENU);
    }

    // Serve the customer menu directly (team members escape dial-out with 0#).
    if (path === "/voice/menu") {
      return twiml(MENU);
    }

    // Team dial-out: place the call from the business number.
    if (path === "/voice/dialout") {
      const form = await request.formData();
      const digits = (form.get("Digits") || "").toString().replace(/\D/g, "");
      const bizNum = (form.get("To") || form.get("Called") || "").toString();
      if (digits === "0") return twiml(`<Redirect method="POST">/voice/menu</Redirect>`);
      if (digits.length === 10 || (digits.length === 11 && digits[0] === "1")) {
        const num = digits.length === 10 ? "+1" + digits : "+" + digits;
        // Log it in the messaging app's call history (best-effort).
        if (env.VM_SECRET) {
          ctx.waitUntil(fetch("https://messaging.thedomebros-com.workers.dev/api/call-event", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-VM-Secret": env.VM_SECRET },
            body: JSON.stringify({ from: num, event: "outgoing" }),
          }).catch(() => {}));
        }
        return twiml(
          say("Connecting.") +
          `<Dial callerId="${bizNum}" answerOnBridge="true"><Number>${num}</Number></Dial>`
        );
      }
      return twiml(say("That number didn't look right.") + `<Redirect method="POST">/voice</Redirect>`);
    }

    // Route the keypress.
    if (path === "/voice/route") {
      const form = await request.formData();
      const digit = (form.get("Digits") || "").toString();

      if (digit === "1" || digit === "2") {
        const cells = (env.SALES_CELLS || "")
          .split(",").map((s) => s.trim()).filter(Boolean);
        if (cells.length === 0) {
          return twiml(
            say("Sorry, no one is available right now.") +
            `<Redirect method="POST">/voice/voicemail</Redirect>`
          );
        }

        // Sequential ring, random order per call. One cell at a time in a plain
        // <Dial> forwards the CUSTOMER'S real caller ID to the cell (an API-placed
        // fan-out can only show our own number), the whisper keeps a cell's
        // voicemail from swallowing the call (it can't press a key, so the leg
        // drops and we move on), and a decline just advances to the next person.
        for (let i = cells.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [cells[i], cells[j]] = [cells[j], cells[i]];
        }

        // Tell the messaging app about the incoming call (push with name + call log).
        const caller = (form.get("From") || "").toString();
        if (env.VM_SECRET) {
          ctx.waitUntil(fetch("https://messaging.thedomebros-com.workers.dev/api/call-event", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-VM-Secret": env.VM_SECRET },
            body: JSON.stringify({ from: caller, event: "incoming" }),
          }).catch(() => {}));
        }

        return twiml(dialStep(origin, cells, 0));
      }

      // 3 (or anything else) → voicemail.
      return twiml(`<Redirect method="POST">/voice/voicemail</Redirect>`);
    }

    // Sequential-ring progression: fires when a leg finishes. DialCallStatus is
    // NOT trustworthy here — a cell that answers the whisper and hangs up (or its
    // voicemail) also reports "completed". Only the whisper KEYPRESS (recorded in
    // KV by /voice/whisper-accept) means the call was really taken; everything
    // else advances to the next cell, then the business voicemail.
    if (path === "/voice/seq") {
      const form = await request.formData();
      const status = (form.get("DialCallStatus") || "").toString();
      if (status === "completed") {
        const accepted = env.CALL_STATE ? await env.CALL_STATE.get("acc:" + (form.get("CallSid") || "")) : null;
        if (accepted) return twiml(`<Hangup/>`);
      }
      const order = (u.searchParams.get("order") || "").split(",").filter(Boolean);
      const i = parseInt(u.searchParams.get("i") || "0", 10);
      if (i < order.length) return twiml(dialStep(origin, order, i));
      return twiml(
        say("Sorry, we couldn't reach anyone right now.") +
        `<Redirect method="POST">/voice/voicemail</Redirect>`
      );
    }

    // Whisper / screen on the ringing cell: a person presses a key to take the
    // call; a cell's voicemail can't, so that leg hangs up un-bridged and the
    // caller is NEVER dumped into a personal greeting.
    if (path === "/voice/whisper") {
      return twiml(
        `<Gather numDigits="1" timeout="8" action="${origin}/voice/whisper-accept" method="POST">` +
          say("Business call. Press any key to take it.") +
        `</Gather>` +
        `<Hangup/>`
      );
    }

    // A key was pressed → accept. Record it against the CUSTOMER'S call (this
    // webhook runs on the cell's leg; ParentCallSid is the customer), then
    // finishing this TwiML bridges the caller in.
    if (path === "/voice/whisper-accept") {
      const parent = ((await request.formData()).get("ParentCallSid") || "").toString();
      if (env.CALL_STATE && parent) {
        ctx.waitUntil(env.CALL_STATE.put("acc:" + parent, "1", { expirationTtl: 3600 }));
      }
      return twiml(say("Connecting you now."));
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
      // Also drop the voicemail into the messaging app (shows in the caller's
      // thread + the Voicemail page). Best-effort; the email above is the backup.
      if (env.VM_SECRET) {
        ctx.waitUntil(fetch("https://messaging.thedomebros-com.workers.dev/api/voicemail", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-VM-Secret": env.VM_SECRET },
          body: JSON.stringify({ from, transcript, recording_url: recordingUrl }),
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
