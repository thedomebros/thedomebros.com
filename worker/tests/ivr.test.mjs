// Tests for the phone IVR worker: menu routing, conference dial-out fan-out,
// whisper accept/decline semantics, all-missed -> voicemail, ringback serving,
// and the voicemail/call-event handoff to the messaging app.
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
    async get(k, type) { const v = store.get(k); if (v === undefined) return null; return v; },
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
  SALES_CELLS: '+18017354578, +18014725872,+13852086150',
  TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok',
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
  const xml = await (await post('/voice', { From: '+18017354578', To: '+13852044760' })).text();
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

console.log('Routing digit 1 -> conference fan-out:');
{
  calls.length = 0;
  const xml = await (await post('/voice/route', { Digits: '1', CallSid: 'CA_caller1', From: '+13855551001', To: '+13852044760' })).text();
  ok('caller parked in conference (does not start it)', xml.includes('<Conference') && xml.includes('startConferenceOnEnter="false"'));
  ok('conference named after caller CallSid', xml.includes('lead-CA_caller1'));
  ok('caller hears ringback via waitUrl', xml.includes('waitUrl') && xml.includes('/voice/hold'));
  const created = find('/Calls.json');
  ok('one outbound call per cell (3)', created.length === 3, 'got ' + created.length);
  ok('cells parsed with trimming', created.some((c) => c.form.To === '+18014725872') && created.some((c) => c.form.To === '+18017354578'));
  ok('agent legs get whisper URL + status callback', created.every((c) => c.form.Url.includes('/voice/agent-whisper') && c.form.StatusCallback.includes('/voice/agent-status')));
  ok('call-event posted to messaging with secret', find('/api/call-event').some((c) => c.opts.headers['X-VM-Secret'] === 'vm_secret_test' && c.json.from === '+13855551001'));
  const st = JSON.parse(await env.CALL_STATE.get('conf:lead-CA_caller1'));
  ok('KV state tracks 3 pending agent legs', st.pending === 3 && st.agentSids.length === 3 && st.joined === false);
}

console.log('Routing with no cells:');
{
  const xml = await (await post('/voice/route', { Digits: '1', CallSid: 'CA_c2', From: '+1x', To: '+1y' }, { ...env, SALES_CELLS: '' })).text();
  ok('no cells -> apology + voicemail', xml.includes('no one is available') && xml.includes('/voice/voicemail'));
}

console.log('Agent whisper & accept:');
{
  const conf = 'lead-CA_caller1';
  const wxml = await (await post('/voice/agent-whisper?conf=' + conf + '&caller=%2B13855551001', { CallSid: 'CA_agent_1' })).text();
  ok('whisper announces the caller number', wxml.includes('business line') && wxml.includes('say-as') && wxml.includes('+13855551001'));
  ok('whisper hangs up if no key pressed', wxml.includes('<Hangup/>'));

  calls.length = 0;
  const st0 = JSON.parse(await env.CALL_STATE.get('conf:' + conf));
  const firstSid = st0.agentSids[0];
  const axml = await (await post('/voice/agent-accept?conf=' + conf, { CallSid: firstSid })).text();
  ok('accept joins + starts the conference', axml.includes('startConferenceOnEnter="true"') && axml.includes(conf));
  ok('conference capped at 2 participants', axml.includes('maxParticipants="2"'));
  const st1 = JSON.parse(await env.CALL_STATE.get('conf:' + conf));
  ok('KV marks joined + acceptedBy', st1.joined === true && st1.acceptedBy === firstSid);
  const canceled = find('/Calls/').filter((c) => c.form && c.form.Status === 'canceled');
  ok('other two ringing legs canceled', canceled.length === 2, 'got ' + canceled.length);
  ok('accepted leg NOT canceled', !canceled.some((c) => c.url.includes(firstSid)));

  const bxml = await (await post('/voice/agent-accept?conf=' + conf, { CallSid: st1.agentSids[1] })).text();
  ok('late second accept told call was taken', bxml.includes('already taken'));
}

console.log('All agents miss -> caller to voicemail:');
{
  // fresh conf with 2 legs, nobody accepts
  await post('/voice/route', { Digits: '2', CallSid: 'CA_caller3', From: '+13855551003', To: '+13852044760' }, { ...env, SALES_CELLS: '+18015550001,+18015550002' });
  calls.length = 0;
  await post('/voice/agent-status?conf=lead-CA_caller3', { CallStatus: 'no-answer' });
  ok('first miss: caller stays on hold', find('/Calls/CA_caller3.json').length === 0);
  await post('/voice/agent-status?conf=lead-CA_caller3', { CallStatus: 'no-answer' });
  const redir = find('/Calls/CA_caller3.json');
  ok('last miss: caller redirected off hold', redir.length === 1 && redir[0].form.Url.includes('/voice/no-answer'));
  const nxml = await (await post('/voice/no-answer', {})).text();
  ok('no-answer apologizes then records voicemail', nxml.includes('/voice/voicemail'));
}

console.log('Ringback & hold:');
{
  const hxml = await (await post('/voice/hold', {})).text();
  ok('hold loops the ringback tone', hxml.includes('<Play loop="0"') && hxml.includes('/voice/ringback.wav'));
  let r = await get('/voice/ringback.wav');
  ok('missing ringback asset -> 404', r.status === 404);
  await env.CALL_STATE.put('asset:ringback', new Uint8Array([82, 73, 70, 70]).buffer);
  r = await get('/voice/ringback.wav');
  ok('ringback served as audio/wav', r.status === 200 && r.headers.get('Content-Type') === 'audio/wav');
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
