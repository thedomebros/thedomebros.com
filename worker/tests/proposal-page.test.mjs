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

console.log(`\nproposal-page.test.mjs: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
