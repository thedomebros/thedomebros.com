// Unit tests for deriveAdSource in quote-form-worker.js — turns raw landing-page
// ad identifiers into a readable "where did this lead come from" label.
// Run: node website/worker/tests/attribution.test.mjs
import { deriveAdSource } from '../quote-form-worker.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n); } };

console.log('deriveAdSource:');
ok('gclid -> Google Ads', deriveAdSource({ gclid: 'abc123' }) === 'Google Ads');
ok('fbclid -> Meta Ads', deriveAdSource({ fbclid: 'xyz' }) === 'Meta Ads');
ok('utm_source=google + cpc -> Google Ads', deriveAdSource({ utm_source: 'google', utm_medium: 'cpc' }) === 'Google Ads');
ok('utm_source=facebook (paid) -> Meta Ads', deriveAdSource({ utm_source: 'facebook', utm_medium: 'paid_social' }) === 'Meta Ads');
ok('utm_source=instagram (no medium) -> Meta', deriveAdSource({ utm_source: 'instagram' }) === 'Meta');
ok('utm_source=google organic (no cpc) -> Google (organic)', deriveAdSource({ utm_source: 'google', utm_medium: 'organic' }) === 'Google (organic)');
ok('campaign name is appended', deriveAdSource({ gclid: 'x', utm_campaign: 'winter-quote' }) === 'Google Ads (winter-quote)');
ok('a named utm_source passes through', deriveAdSource({ utm_source: 'newsletter' }) === 'newsletter');
ok('google referrer, no utm -> Google (organic)', deriveAdSource({ referrer: 'https://www.google.com/' }) === 'Google (organic)');
ok('facebook referrer -> Meta (organic)', deriveAdSource({ referrer: 'https://l.facebook.com/' }) === 'Meta (organic)');
ok('other referrer -> Referral: host', deriveAdSource({ referrer: 'https://www.reddit.com/r/pools' }) === 'Referral: reddit.com');
ok('nothing -> Direct', deriveAdSource({}) === 'Direct');
ok('null-safe', deriveAdSource(null) === '' && deriveAdSource(undefined) === '');

console.log(`\nattribution.test.mjs: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
