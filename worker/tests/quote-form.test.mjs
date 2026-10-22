// The quote form's bot check. A failed Turnstile check has to stop the
// submission cold: no lead email, no auto-reply, no lead on the board. Flagging
// failures for review instead let a run of 130+ casino-spam leads through.
// Run: node website/worker/tests/quote-form.test.mjs
import worker from '../quote-form-worker.js';

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, extra); } };

// Every outbound call the worker makes, by where it went.
let calls = [];
let siteverify = () => Response.json({ success: true });
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, opts });
  if (u.includes('challenges.cloudflare.com')) return siteverify(opts);
  if (u.includes('api.resend.com')) return Response.json({ id: 'email_test' });
  return Response.json({ ok: true });
};
const messaging = [];
const env = (over = {}) => ({
  RESEND_API_KEY: 're_test', LEAD_TO: 'leads@example.com', MAIL_FROM: 'TheDomeBros <q@example.com>',
  TURNSTILE_SECRET: 'ts_secret', LEAD_LOG_URL: 'https://leadlog.example/exec', MESSAGING_INGEST_SECRET: 'ingest',
  MESSAGING: { fetch: async (u, init) => { messaging.push(u); return Response.json({ ok: true, schedule_url: 'https://x/s' }); } },
  ...over,
});

async function submit(fields, e = env()) {
  calls = []; messaging.length = 0;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const jobs = [];
  const res = await worker.fetch(new Request('https://quote-form.example/', {
    method: 'POST', body: fd, headers: { Origin: 'https://thedomebros.com', 'CF-Connecting-IP': '203.0.113.9' },
  }), e, { waitUntil: (p) => jobs.push(Promise.resolve(p).catch(() => {})) });
  await Promise.all(jobs);
  return { res, body: await res.json() };
}
const lead = { name: 'Pat Pool', phone: '801-555-0142', email: 'pat@example.com', pool_size: '16 x 32', source: 'pricing', 'cf-turnstile-response': 'tok_good' };
const sent = (host) => calls.filter((c) => c.url.includes(host));

console.log('Quote form bot check:');
{
  siteverify = () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] });
  let { res, body } = await submit(lead);
  ok('a failed check is rejected', res.status === 403 && body.success === false);
  ok('...with a message the visitor can act on', /refresh the page and try again/.test(body.message));
  ok('...and no lead email or auto-reply goes out', sent('api.resend.com').length === 0);
  ok('...nothing reaches the messaging app', messaging.length === 0);
  ok('...or the lead log', sent('leadlog.example').length === 0);
  const sv = sent('challenges.cloudflare.com')[0];
  ok('the token and visitor IP are checked with Cloudflare', sv && sv.opts.body.get('response') === 'tok_good' && sv.opts.body.get('remoteip') === '203.0.113.9' && sv.opts.body.get('secret') === 'ts_secret');

  ({ res, body } = await submit({ ...lead, 'cf-turnstile-response': '' }));
  ok('no token at all is rejected without asking Cloudflare', res.status === 403 && sent('challenges.cloudflare.com').length === 0 && sent('api.resend.com').length === 0);

  ({ res } = await submit({ ...lead, source: 'quick-landing', name: '', pool_size: '' }));
  ok('the quick form is held to the same check', res.status === 403 && sent('api.resend.com').length === 0);

  siteverify = () => Response.json({ success: true });
  ({ res, body } = await submit(lead));
  ok('a passed check goes through', res.status === 200 && body.success === true);
  const leadMail = sent('api.resend.com').map((c) => JSON.parse(c.opts.body)).find((m) => m.to[0] === 'leads@example.com');
  ok('...the lead email is sent, with no unverified warning', leadMail && leadMail.subject === 'New quote request (pricing) — Pat Pool' && !/UNVERIFIED/i.test(leadMail.html));
  ok('...and the lead reaches the messaging app', messaging.some((u) => u.endsWith('/api/ingest')) && messaging.some((u) => u.endsWith('/api/ingest-quote')));

  // Cloudflare being down is not the visitor's fault; real leads still get in.
  siteverify = () => { throw new Error('network down'); };
  ({ res } = await submit(lead));
  ok('if Cloudflare cannot be reached the lead still goes through', res.status === 200 && sent('api.resend.com').length > 0);

  siteverify = () => Response.json({ success: false });
  ({ res } = await submit(lead, env({ TURNSTILE_SECRET: undefined })));
  ok('with no Turnstile secret set, the check is skipped', res.status === 200 && sent('challenges.cloudflare.com').length === 0);

  ({ res, body } = await submit({ ...lead, botcheck: 'filled by a bot' }));
  ok('the honeypot still quietly drops bots', res.status === 200 && body.lead === false && sent('api.resend.com').length === 0 && messaging.length === 0);
}

console.log(`\nquote-form.test.mjs: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
