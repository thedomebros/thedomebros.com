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
//   Var/Secret SALES_CELLS        : comma-separated E.164 cells to ring (all at once)
//   Secret     RESEND_API_KEY     : Resend API key (the same one the quote Worker uses)
//   Var        MAIL_FROM          : verified sender, e.g. "TheDomeBros <quotes@thedomebros.com>"
//   Var        LEAD_TO            : inbox that receives voicemails and inbound texts
//   Secret     TWILIO_ACCOUNT_SID : used to fan out the call-routing conference legs
//   Secret     TWILIO_AUTH_TOKEN  : "
//   KV         CALL_STATE         : per-call ring state (bound in wrangler.ivr.toml)
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

// ---- Twilio REST API (drives the call-routing conference fan-out) ----
function twilioAuth(env) {
  return "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
}
async function twilioCreateCall(env, params) {
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`,
    { method: "POST", headers: { Authorization: twilioAuth(env), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) }
  );
  if (!res.ok) throw new Error(`Twilio create call ${res.status}: ${await res.text()}`);
  return res.json();
}
// Redirect a live call (Url) or end it (Status). Best-effort — a leg that already
// ended returns an error we can safely ignore.
function twilioUpdateCall(env, callSid, params) {
  return fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`,
    { method: "POST", headers: { Authorization: twilioAuth(env), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) }
  );
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

        // Conference "dial-out" fan-out. We deliberately DON'T use <Dial><Number>:
        // there, the first cell to answer cancels the others, so one person
        // declining the whisper kills the call for everyone. Instead the caller
        // waits in a conference while we ring each cell as its own outbound call;
        // whoever presses a key joins the conference, and a decline / no-answer
        // only drops that one leg. See /voice/agent-whisper, -accept, -status.
        const callerSid = (form.get("CallSid") || "").toString();
        const bizNum = (form.get("To") || form.get("Called") || "").toString();
        const caller = (form.get("From") || "").toString();
        const conf = `lead-${callerSid}`;
        const q = `conf=${encodeURIComponent(conf)}&caller=${encodeURIComponent(caller)}`;

        ctx.waitUntil((async () => {
          const agentSids = [];
          for (const cell of cells) {
            try {
              const call = await twilioCreateCall(env, {
                To: cell,
                From: bizNum,
                Url: `${origin}/voice/agent-whisper?${q}`,
                Method: "POST",
                Timeout: "20",
                StatusCallback: `${origin}/voice/agent-status?conf=${encodeURIComponent(conf)}`,
                StatusCallbackEvent: "completed",
                StatusCallbackMethod: "POST",
              });
              if (call && call.sid) agentSids.push(call.sid);
            } catch (e) { /* one cell failing shouldn't stop the others */ }
          }
          await env.CALL_STATE.put(`conf:${conf}`, JSON.stringify({
            callerSid, agentSids, pending: agentSids.length, joined: false,
          }), { expirationTtl: 600 });
          // Nothing could be dialed → don't strand the caller on hold.
          if (agentSids.length === 0 && callerSid) {
            await twilioUpdateCall(env, callerSid, { Url: `${origin}/voice/no-answer`, Method: "POST" }).catch(() => {});
          }
        })());

        // Park the caller in the conference; an accepting agent starts it. The
        // waitUrl plays a ringback tone so the caller hears ringing (not silence)
        // until someone picks up.
        return twiml(
          `<Dial><Conference startConferenceOnEnter="false" endConferenceOnExit="true" ` +
          `beep="false" waitUrl="${origin}/voice/hold">${conf}</Conference></Dial>`
        );
      }

      // 3 (or anything else) → voicemail.
      return twiml(`<Redirect method="POST">/voice/voicemail</Redirect>`);
    }

    // Ringback the caller hears while we ring the team — a real US ring cadence
    // that stops the instant someone accepts (the conference starts and bridges
    // them in). loop="0" repeats the tone forever until then.
    if (path === "/voice/hold") {
      return twiml(`<Play loop="0">${origin}/voice/ringback.wav</Play>`);
    }

    // Ringback tone audio (8 kHz mono WAV in KV) that the waitUrl above plays.
    if (path === "/voice/ringback.wav") {
      const buf = await env.CALL_STATE.get("asset:ringback", "arrayBuffer");
      if (!buf) return new Response("not found", { status: 404 });
      return new Response(buf, { headers: { "Content-Type": "audio/wav", "Cache-Control": "public, max-age=86400" } });
    }

    // Each ringing cell hits this when it answers: screen with a whisper. Pressing
    // a key joins the conference; no key (or a cell's voicemail) just drops this
    // leg, leaving the other cells ringing.
    if (path === "/voice/agent-whisper") {
      const conf = u.searchParams.get("conf") || "";
      const caller = u.searchParams.get("caller") || "";
      const fromPhrase = caller ? ` from <say-as interpret-as="telephone">${caller}</say-as>` : "";
      return twiml(
        `<Gather numDigits="1" timeout="10" action="${origin}/voice/agent-accept?conf=${encodeURIComponent(conf)}" method="POST">` +
          say(`You have a call on your business line${fromPhrase}. Press any key to take it.`) +
        `</Gather>` +
        `<Hangup/>`
      );
    }

    // A cell pressed a key → they take the call. Cancel the other still-ringing
    // legs, then join the conference (capped at 2 so a late second accept can't
    // create a three-way).
    if (path === "/voice/agent-accept") {
      const conf = u.searchParams.get("conf") || "";
      const thisSid = ((await request.formData()).get("CallSid") || "").toString();
      const raw = await env.CALL_STATE.get(`conf:${conf}`);
      const st = raw ? JSON.parse(raw) : null;
      if (st && st.joined && st.acceptedBy && st.acceptedBy !== thisSid) {
        return twiml(say("Sorry, this call was already taken by someone else. Goodbye.") + `<Hangup/>`);
      }
      ctx.waitUntil((async () => {
        const cur = await env.CALL_STATE.get(`conf:${conf}`);
        if (!cur) return;
        const s = JSON.parse(cur);
        if (s.joined) return;
        s.joined = true; s.acceptedBy = thisSid;
        await env.CALL_STATE.put(`conf:${conf}`, JSON.stringify(s), { expirationTtl: 600 });
        for (const sid of s.agentSids) {
          if (sid !== thisSid) twilioUpdateCall(env, sid, { Status: "canceled" }).catch(() => {});
        }
      })());
      return twiml(
        say("Connecting you now.") +
        `<Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true" ` +
        `beep="false" maxParticipants="2">${conf}</Conference></Dial>`
      );
    }

    // Fires as each agent leg ends. Once every leg has ended with nobody having
    // accepted, pull the caller off hold and end the call politely (no voicemail).
    if (path === "/voice/agent-status") {
      const conf = u.searchParams.get("conf") || "";
      ctx.waitUntil((async () => {
        const raw = await env.CALL_STATE.get(`conf:${conf}`);
        if (!raw) return;
        const st = JSON.parse(raw);
        if (st.joined) return;
        st.pending = Math.max(0, (st.pending || 0) - 1);
        await env.CALL_STATE.put(`conf:${conf}`, JSON.stringify(st), { expirationTtl: 600 });
        if (st.pending === 0 && st.callerSid) {
          await twilioUpdateCall(env, st.callerSid, { Url: `${origin}/voice/no-answer`, Method: "POST" }).catch(() => {});
        }
      })());
      return new Response("ok");
    }

    // Nobody picked up — send the caller to voicemail so the lead isn't lost.
    if (path === "/voice/no-answer") {
      return twiml(
        say("Sorry, we couldn't reach anyone right now.") +
        `<Redirect method="POST">/voice/voicemail</Redirect>`
      );
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
