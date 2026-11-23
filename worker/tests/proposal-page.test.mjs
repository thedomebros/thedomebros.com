// The proposal page's render(): run the real page code against proposal data
// and check what the customer would see.
// Run: node website/worker/tests/proposal-page.test.mjs
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  PASS', n); } else { fail++; console.log('  FAIL', n, extra); } };

const html = readFileSync(join(SITE, 'proposal.html'), 'utf8');
// The page's helpers and render(), without the code that fetches and boots it.
const src = (html.match(/(var esc = function[\s\S]*?\nfunction shot\(src, alt\)\{[\s\S]*?\n\})/) || [])[1] || '';
ok('render code was found', src.includes('function render(d)'));

function show(d) {
  const root = { innerHTML: '' };
  const ctx = { document: { getElementById: () => root } };
  vm.runInNewContext(src + '\nrender(data);', Object.assign(ctx, { data: d }));
  return root.innerHTML;
}
const base = { name: 'Dan Alger', price: 21000, options: {}, render: 'https://m.test/media/viz%2Fw.jpg' };

console.log('Summer view on the proposal:');
let out = show(base);
ok('no summer section without a summer render', !/And in summer/.test(out));
ok('the winter render still shows', out.includes('src="https://m.test/media/viz%2Fw.jpg"'));

out = show({ ...base, render_summer: 'https://m.test/media/viz%2Fs.jpg' });
ok('with one, the summer section appears', /And in summer/.test(out));
ok('...showing their own yard with the dome down', out.includes('src="https://m.test/media/viz%2Fs.jpg"'));
ok('the anchor close-up stays on the website, not the proposal', !out.includes('anchor-closeup'));
ok('...right after the winter render, before the rest of the page', out.indexOf('class="hero"') < out.indexOf('And in summer') && out.indexOf('And in summer') < out.indexOf('What changes'));
ok('the close-up file exists on the site for the FAQ', existsSync(join(SITE, 'Images', 'anchor-closeup.webp')));

out = show({ ...base, render_summer: 'https://m.test/x.jpg" onerror="alert(1)' });
ok('the summer URL is escaped', !out.includes('onerror="alert(1)"'));

console.log('FAQ:');
const faq = readFileSync(join(SITE, 'faq.html'), 'utf8');
const ans = (faq.match(/What does my backyard look like when the dome is down\?<\/summary>([\s\S]*?)<\/details>/) || [])[1] || '';
ok('the dome-down answer shows the real anchor', ans.includes('src="/Images/anchor-closeup.webp"'));

console.log('Before we have quoted them:');
// The same link gets sent to brand-new contacts who just want information, so
// the page has to work with no price, no render and no name.
out = show({ ok: true });
ok('leads with the pitch, not "Your proposal"', out.includes('Swim all winter') && !out.includes('Your proposal'));
ok('explains what a measurement involves', out.includes('What a measurement costs you'));
ok('asks for the appointment, not a signature', out.includes('Book a free measurement') && !out.includes('Review &amp; sign'));
ok('no empty price card', !out.includes('Your price'));

// A render can exist before a price does — greet them by name anyway.
out = show({ ...base, price: undefined, contract: undefined });
ok('a render with no price still greets them by name', out.includes('Dan’s pool dome') && !out.includes('Swim all winter'));
ok('...and still asks for the measurement', out.includes('Book a free measurement'));

console.log('Price:');
out = show({ ...base, price: 20100, price_max: null });
ok('a single price renders once', out.includes('$20,100') && out.includes('$10,050'));
out = show({ ...base, price: 19000, price_max: 24000 });
ok('a ranged quote shows the range, not the low end alone', out.includes('$19,000–$24,000'));
ok('...and splits both ends of the deposit', out.includes('$9,500–$12,000'));
ok('...and says the contract will not exceed it', out.includes('higher than the top of this range'));
out = show({ ...base, price: 19000, price_max: 19000 });
ok('a max equal to the min is not a range', !out.includes('$19,000–$19,000'));

console.log('What the customer is told:');
out = show({ ...base, sqft: 1008, pool_size: '20 x 40' });
ok('their own dome footprint appears', out.includes('1,008 sq ft'));
ok('their pool as they described it appears', out.includes('20 x 40'));
ok('the published vinyl spec appears', out.includes('20 mil PVC'));
ok('the blower running cost is given as a number', out.includes('$28–35 a month'));
ok('...and pool heating is named as the bigger, separate cost', /Heating the pool/.test(out));
ok('seasonal service is not implied to be included', /optional, priced separately/.test(out));
ok('the old "not the one looking after it" claim is gone', !out.includes('We put it up, take it down, store it'));
ok('the lead time is stated', out.includes('one to four months'));
ok('drilling the deck is disclosed', /drill into your deck/i.test(out));
ok('the second-entry deadline is disclosed', /second entry has to be decided now/i.test(out));
ok('the heater freeze risk is disclosed', /drained in a hard freeze/i.test(out));
ok('buying direct is answered rather than dodged', out.includes('Why not buy one direct'));
ok('the license and insurance are shown', out.includes('14296899-5501') && out.includes('$1M per occurrence'));
ok('walls are the real 5 ft 6 in, not "about 6 feet"', out.includes('5 ft 6 in') && !/Walls stand about 6 feet/.test(out));
ok('deflation time is given by size, not one figure for everyone', /3 to 5 minutes/.test(out) && /15 to 20/.test(out));
ok('the gallery links out to the full set', out.includes('href="/gallery"'));
ok('...in a new tab, so the proposal stays open', /href="\/gallery" target="_blank"/.test(out));
// The photos are used with the manufacturer's written permission, so the page
// does not apologise for them.
ok('no disclaimer on the photos', !/installs, not ours/.test(out));
// The manufacturer is not named: a customer who goes looking can buy direct.
ok('the manufacturer is not named', !/Ameri-Brand|Ameridome|Ameri Dome/i.test(out));
ok('the self-draining heater mount is stated as what we do', /We mount yours tilted/.test(out));
ok('...but the dome is still credited as US-made', /Made in the USA/.test(out));
// The LLC is registered at a family home; that address stays off a page we send out.
ok('the street address is not on the page', !out.includes('4558') && !out.includes('9820'));
ok('...just the city', /Cedar Hills, Utah/.test(out));
// We do not actually compute a heating figure for people, so we do not offer to.
ok('no offer to work out a heating number', !/work out a number/.test(out));
ok('...but heating is still named as the bigger cost', /Heating the pool/.test(out));

console.log('Sharing:');
ok('a share button is offered on a full proposal', out.includes('id="shareBtn"'));
ok('...and the handler is wired to the native share sheet', html.includes('navigator.share'));
ok('...with a clipboard fallback', html.includes('navigator.clipboard'));
out = show({ ok: true });
ok('...and on the version sent before a quote', out.includes('id="shareBtn"'));
out = show({ ...base, contract: undefined, price: 21000 });
ok('...and on the quoted-but-unsigned version', out.includes('id="shareBtn"'));
out = show({ ...base, sqft: 1008, pool_size: '20 x 40' });

console.log('The manufacturer stays unnamed site-wide:');
// A customer who learns the manufacturer's name can buy the dome direct, so the
// name belongs in the repo and the contracts, never on a page we publish.
for (const page of ['index.html', 'gallery.html', 'proposal.html', 'faq.html', 'about.html',
                    'pricing.html', 'swim-year-round.html', 'selections.html', 'contact.html']) {
  const src = readFileSync(join(SITE, page), 'utf8');
  ok(`${page} does not name them`, !/ameri-?brand|ameri ?dome/i.test(src));
}
ok('the gallery still attributes the photos', /used with permission/i.test(readFileSync(join(SITE, 'gallery.html'), 'utf8')));

console.log(`\nproposal-page.test.mjs: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
