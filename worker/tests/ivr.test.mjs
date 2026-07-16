// Tests for the phone IVR worker: menu routing, sequential ring (random order,
// caller-ID passthrough), whisper accept/decline semantics, all-missed ->
// voicemail, team call-through, and the messaging-app handoff.
// Run: node worker/tests/ivr.test.mjs   (self-contained; no deps)
import worker from '../twilio-ivr-worker.js';

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, extra); } };

// ---- tiny mocks (kept local so this repo stays standalone) ----
function makeKV() {
  const store = new Map();
  return {
    store,
    async put(k, v) { store.set(k, v); },
    async get(k) { const v = store.get(k); return v === undefined ? null : v; },
  };
}
const calls = [];
let responder = null;
globalThis.fetch = async (url, opts = {}) => {
  const rec = { url: String(url), opts };
  if (opts.body instanceof URLSearchParams) rec.form = Object.fromEntries(opts.body);
  try { if (typeof opts.body === 'string') rec.json = JSON.parse(opts.body); } catch {}
  calls.push(rec);
  const r = responder && (await responder(rec));
  if (r) return r;
  if (rec.url.includes('/Calls.json')) return Response.json({ sid: 'CA_agent_' + calls.length });
  return Response.json({ ok: true });
};
const find = (s) => calls.filter((c) => c.url.includes(s));
function ctx() { const jobs = []; return { waitUntil(p) { jobs.push(Promise.resolve(p).catch(() => {})); }, flush: () => Promise.all(jobs) }; }

const BASE = 'https://twilio-ivr.test.workers.dev';
const env = {
  SALES_CELLS: '+13855550201, +13855550202,+13855550203',
  VM_SECRET: 'vm_secret_test',
  CALL_STATE: makeKV(),
};
async function post(path, params, e = env) {
  const c = ctx();
  const res = await worker.fetch(new Request(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) }), e, c);
  await c.flush();
  return res;
}
const get = (path, e = env) => worker.fetch(new Request(BASE + path), e, ctx());

console.log('Menu:');
{
  const xml = await (await post('/voice', {})).text();
  ok('menu gathers a digit to /voice/route', xml.includes('<Gather') && xml.includes('/voice/route'));
  ok('menu repeats on no input', xml.includes('<Redirect') && xml.includes('/voice'));
  const info = await (await get('/')).text();
  ok('root serves info text', info.includes('IVR'));
}

console.log('Team call-through (dial-out):');
{
  const xml = await (await post('/voice', { From: '+13855550201', To: '+13852044760' })).text();
  ok('team caller gets dial-out, not the menu', xml.includes('/voice/dialout') && !xml.includes('/voice/route'));
  calls.length = 0;
  const dxml = await (await post('/voice/dialout', { Digits: '8015551234', To: '+13852044760' })).text();
  ok('dials entered number as the business line', dxml.includes('callerId="+13852044760"') && dxml.includes('+18015551234'));
  ok('outgoing call logged to messaging', find('/api/call-event').some((c) => c.json.event === 'outgoing' && c.json.from === '+18015551234'));
  const zxml = await (await post('/voice/dialout', { Digits: '0', To: '+13852044760' })).text();
  ok('0# escapes to the customer menu', zxml.includes('/voice/menu'));
  const mxml = await (await post('/voice/menu', {})).text();
  ok('/voice/menu serves the menu', mxml.includes('/voice/route'));
  const badxml = await (await post('/voice/dialout', { Digits: '12', To: '+13852044760' })).text();
  ok('bad digits -> retry', badxml.includes("didn't look right") || badxml.includes('/voice'));
  const cxml = await (await post('/voice', { From: '+15559998888', To: '+13852044760' })).text();
  ok('customers still get the menu', cxml.includes('/voice/route'));
}

console.log('Routing digit 3 -> voicemail:');
{
  const xml = await (await post('/voice/route', { Digits: '3', CallSid: 'CA_caller0', From: '+13855551000', To: '+13852044760' })).text();
  ok('goes straight to voicemail', xml.includes('/voice/voicemail'));
}

console.log('Routing digit 1 -> sequential ring (random order):');
{
  calls.length = 0;
  const xml = await (await post('/voice/route', { Digits: '1', CallSid: 'CA_caller1', From: '+13855551001', To: '+13852044760' })).text();
  ok('dials exactly one cell at a time', (xml.match(/<Number/g) || []).length === 1);
  ok('no callerId override — customer number passes through', !xml.includes('callerId='));
  ok('leg is whisper-screened', xml.includes('/voice/whisper'));
  ok('dial action advances the sequence', xml.includes('/voice/seq') && xml.includes('i=1'));
  ok('sequence carries the full shuffled order', xml.includes(encodeURIComponent('+13855550201')) || xml.includes('+13855550201'));
  ok('call-event posted to messaging with secret', find('/api/call-event').some((c) => c.opts.headers['X-VM-Secret'] === 'vm_secret_test' && c.json.from === '+13855551001'));
  const firsts = new Set();
  for (let k = 0; k < 12; k++) {
    const x = await (await post('/voice/route', { Digits: '1', CallSid: 'CA_r' + k, From: '+13855551001', To: '+13852044760' })).text();
    const m = x.match(/<Number[^>]*>(\+\d+)<\/Number>/);
    if (m) firsts.add(m[1]);
  }
  ok('first cell is randomized across calls', firsts.size >= 2, [...firsts].join(','));
}

console.log('Routing with no cells:');
{
  const xml = await (await post('/voice/route', { Digits: '1', CallSid: 'CA_c2', From: '+1x', To: '+1y' }, { ...env, SALES_CELLS: '' })).text();
  ok('no cells -> apology + voicemail', xml.includes('no one is available') && xml.includes('/voice/voicemail'));
}

console.log('QUOTE_FIRST_CELL (sales rep rings first on press 1):');
{
  const repEnv = { ...env, QUOTE_FIRST_CELL: '+13855559999' };
  let repFirst = true, svcRepFirst = 0;
  for (let k = 0; k < 8; k++) {
    const x1 = await (await post('/voice/route', { Digits: '1', CallSid: 'CA_q' + k, From: '+13855551002', To: '+13852044760' }, repEnv)).text();
    const m1 = x1.match(/<Number[^>]*>(\+\d+)<\/Number>/);
    if (!m1 || m1[1] !== '+13855559999') repFirst = false;
    const x2 = await (await post('/voice/route', { Digits: '2', CallSid: 'CA_s' + k, From: '+13855551002', To: '+13852044760' }, repEnv)).text();
    const m2 = x2.match(/<Number[^>]*>(\+\d+)<\/Number>/);
    if (m2 && m2[1] === '+13855559999') svcRepFirst++;
  }
  ok('press 1 always rings the rep first', repFirst);
  ok('press 2 never routes to the rep (not in SALES_CELLS)', svcRepFirst === 0);
  const dup = await (await post('/voice/route', { Digits: '1', CallSid: 'CA_qd', From: '+13855551002', To: '+13852044760' }, { ...env, QUOTE_FIRST_CELL: '+13855550201' })).text();
  const order = decodeURIComponent((dup.match(/order=([^&"]+)/) || [])[1] || '');
  ok('rep already in SALES_CELLS is not doubled', order.split(',').filter((c) => c === '+13855550201').length === 1 && order.split(',')[0] === '+13855550201');
  const only = await (await post('/voice/route', { Digits: '1', CallSid: 'CA_qo', From: '+1x', To: '+1y' }, { SALES_CELLS: '', QUOTE_FIRST_CELL: '+13855559999', VM_SECRET: 'vm_secret_test', CALL_STATE: env.CALL_STATE })).text();
  ok('rep alone still rings with no team cells', only.includes('+13855559999'));
}

console.log('Sequential progression (/voice/seq):');
{
  const order = encodeURIComponent('+18011111111,+18022222222,+18033333333');
  let xml = await (await post('/voice/seq?order=' + order + '&i=1', { CallSid: 'CA_cust1', DialCallStatus: 'no-answer' })).text();
  ok('no-answer advances to the next cell', xml.includes('+18022222222') && xml.includes('i=2'));
  xml = await (await post('/voice/seq?order=' + order + '&i=1', { CallSid: 'CA_cust1', DialCallStatus: 'busy' })).text();
  ok('busy also advances', xml.includes('+18022222222'));
  // THE BUG WE SHIPPED ONCE: a cell that answers the whisper and hangs up (or
  // its voicemail) reports "completed" — it must ADVANCE, not hang up on the customer.
  xml = await (await post('/voice/seq?order=' + order + '&i=1', { CallSid: 'CA_cust1', DialCallStatus: 'completed' })).text();
  ok('answered-but-not-accepted still advances', xml.includes('+18022222222') && !xml.includes('<Hangup/>'));
  // Accepted via keypress -> completed really means taken.
  await post('/voice/whisper-accept', { CallSid: 'CA_leg9', ParentCallSid: 'CA_cust1', Digits: '5' });
  xml = await (await post('/voice/seq?order=' + order + '&i=1', { CallSid: 'CA_cust1', DialCallStatus: 'completed' })).text();
  ok('accepted call ends cleanly, no more ringing', xml.includes('<Hangup/>') && !xml.includes('<Dial'));
  xml = await (await post('/voice/seq?order=' + order + '&i=3', { CallSid: 'CA_cust2', DialCallStatus: 'no-answer' })).text();
  ok('all missed -> apology + voicemail', xml.includes('/voice/voicemail'));
}

console.log('Whisper screen:');
{
  const wxml = await (await post('/voice/whisper', { CallSid: 'CA_leg1' })).text();
  ok('whisper gathers a key to accept', wxml.includes('<Gather') && wxml.includes('/voice/whisper-accept'));
  ok('no key (voicemail answered) drops the leg', wxml.includes('<Hangup/>'));
  const axml = await (await post('/voice/whisper-accept', { Digits: '5' })).text();
  ok('key press bridges the call', axml.includes('Connecting'));
}

console.log('Voicemail record + handoff:');
{
  const vxml = await (await post('/voice/voicemail', {})).text();
  ok('voicemail records with transcription', vxml.includes('<Record') && vxml.includes('transcribe="true"') && vxml.includes('/voice/vm-done'));
  const hup = await (await post('/voice/vm-hangup', {})).text();
  ok('post-recording goodbye + hangup', hup.includes('<Hangup/>'));
  calls.length = 0;
  const r = await post('/voice/vm-done', { From: '+13855551004', RecordingUrl: 'https://api.twilio.com/rec/RE9', TranscriptionText: 'please call me back' });
  ok('vm-done returns ok', r.status === 200);
  const hand = find('/api/voicemail');
  ok('voicemail handed to messaging app with secret', hand.length === 1 && hand[0].opts.headers['X-VM-Secret'] === 'vm_secret_test');
  ok('handoff carries transcript + recording url', hand[0].json.transcript === 'please call me back' && hand[0].json.recording_url.includes('RE9'));
}

console.log('Inbound SMS auto-reply:');
{
  const xml = await (await post('/sms', { From: '+13855551005', Body: 'hi' })).text();
  ok('auto-reply message returned', xml.includes('<Message>') && xml.includes('thedomebros.com'));
}

console.log(`\nivr.test.mjs: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
