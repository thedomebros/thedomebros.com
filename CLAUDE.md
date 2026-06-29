# TheDomeBros — Project Guide

## The business

**TheDomeBros LLC** sells and installs **air-supported pool domes** (vinyl
"bubble" enclosures) that turn an existing outdoor pool into a usable,
year-round swimmable space. Service area: **Utah County, UT** (Provo, Orem,
Lehi, American Fork, Spanish Fork, Pleasant Grove, Saratoga Springs, Eagle
Mountain, Highland, Alpine, Cedar Hills, Mapleton, Springville, Payson).

- Contact email: **contact@thedomebros.com**
- The product is air-supported (no poles/framing) — a blower keeps it inflated.
- Positioning keywords we care about for SEO: **"pool dome"** (ranking well) and
  **"pool enclosure"** (the gap we're trying to close — the word "enclosure" was
  deliberately worked into titles/meta across indexed pages).

## The site

Plain **static HTML**, no build step, no framework. Hosted on **GitHub Pages**
with a custom domain.

- **Domain / hosting:** `CNAME` → `thedomebros.com`; served by GitHub Pages.
  `.nojekyll` disables Jekyll processing.
- **Git remote:** `git@github.com-domebros:thedomebros/thedomebros.com.git`
  (note the SSH host alias `github.com-domebros`). Default branch: **master**.
- **DNS / edge:** registrar Porkbun, with DNS pointing **directly at GitHub
  Pages** (`thedomebros.com` resolves to GitHub's IPs `185.199.108–111.153`).
  Cloudflare does **not** proxy or cache the site — the Cloudflare account is
  used only for the Workers (`*.workers.dev`: quote-form + phone IVR) and
  Turnstile bot protection. There is no Cloudflare cache to purge; GitHub Pages serves the
  site through its own CDN, which auto-purges on each push.
- **Analytics:** Google Analytics 4, measurement ID `G-E3Z0CTDFY2`, inlined in
  every page's `<head>`.

### Pages

Indexed (in `sitemap.xml`):
- `index.html` → `/` — homepage
- `about.html` → `/about`
- `pricing.html` → `/pricing` — "Request a Quote" landing (CTAs point here)
- `faq.html` → `/faq`
- `contact.html` → `/contact` — email + "Leave us a Google review" link

`noindex` (intentionally not in sitemap, `<meta name="robots" content="noindex">`):
- `quote.html` — the actual quote **form** page
- `privacy.html` — privacy policy

Prototypes / not linked from nav: `mockup*.html`, `mockups.html`,
`mockup*-contact.html`. These are old design explorations — **ignore them** for
real changes unless explicitly asked.

### Structure

- `css/site.css` — the live stylesheet (all real pages link this).
  `css/styles.css` is legacy/mockup-era.
- `js/scripts.js` — legacy/mockup script. The live quote form's JS is **inline**
  at the bottom of `quote.html`.
- `assets/` — brand images:
  - `favicon-domebros.png` (512×512) — referenced by every page's
    `<link rel="icon" sizes="512x512">`.
  - `favicon.ico` (root, 128×128) — for bots/browsers probing `/favicon.ico`.
  - `apple-touch-icon.png`
  - `logo.png` (490×225, wide) — brand logo, used as OG/Twitter image and the
    intended **GBP cover photo**.
  - `logo-square.png` (500×500, cream-padded) — square version made to satisfy
    Google Business Profile's 250×250 logo minimum.
- `Images/` — photography (`Gray Bubble Cover Cropped.png`, `Inside Bubble
  Cropped.png`).
- `robots.txt`, `sitemap.xml` — standard SEO files.
- `.claude/settings.local.json` — local Claude Code settings (not site content).

### SEO conventions (already applied — match these when editing pages)

Each indexed page carries: a keyword-leading `<title>`, `meta description`,
`<link rel="canonical">`, OpenGraph (`og:*`) and Twitter (`twitter:*`) tags
mirroring the title/description, and the favicon `sizes` attribute. The
homepage has JSON-LD `LocalBusiness`; the FAQ has JSON-LD `FAQPage`. Keep
"pool dome" **and** "pool enclosure" present in titles/meta.

## Quote form → email pipeline

The quote form (`quote.html`) POSTs to a **Cloudflare Worker** deployed at
`https://quote-form.thedomebros-com.workers.dev`. The Worker source lives in
the repo at `worker/quote-form-worker.js` and is **the deploy source** — push
changes with the `wrangler` CLI (see *Deploying Workers* below).

What the Worker does: validates origin/attachments, emails the lead to the
business inbox (with uploaded files attached), and sends an auto-reply to the
submitter — all via the **Resend API**.

Worker config is set in the Cloudflare dashboard, **never hardcoded** (so the
repo can stay public). `keep_vars = true` in the wrangler config preserves these
across deploys:
- Secret `RESEND_API_KEY`
- Var `LEAD_TO` — inbox that receives quote requests
- Var `MAIL_FROM` — verified Resend sender (e.g. `TheDomeBros <quotes@thedomebros.com>`)

Limits enforced both client-side and in the Worker: **6 files / 20 MB total**.

## Phone line (Twilio IVR)

`worker/twilio-ivr-worker.js` is a second Worker (`twilio-ivr`) that powers the
business phone line via **Twilio**: an inbound call gets a keypad menu (1 = new
quote, 2 = existing/seasonal, 3 = leave a message), rings the team's cells, and
emails a transcribed voicemail; inbound texts are emailed with an auto-reply.
Same **Resend** setup as the quote Worker. Twilio's number webhooks point at
`/voice` and `/sms` (HTTP POST). Config (dashboard vars/secrets): `SALES_CELLS`
(comma-separated E.164), plus the shared `RESEND_API_KEY`, `LEAD_TO`, `MAIL_FROM`.

## Deploying Workers (wrangler CLI)

Workers are deployed with the **`wrangler` CLI** (`wrangler login` already done).
Each Worker has a config in `worker/`:

| Worker | Config | Source |
| --- | --- | --- |
| `quote-form` | `wrangler.quote.toml` | `quote-form-worker.js` |
| `twilio-ivr` | `wrangler.ivr.toml` | `twilio-ivr-worker.js` |

Deploy (updates the existing Worker of the same name):

```
cd website/worker
npx wrangler deploy -c wrangler.quote.toml   # or wrangler.ivr.toml
```

Config (vars + secrets) lives in the **Cloudflare dashboard**, not the repo, so
it stays public-safe; `keep_vars = true` in each config stops a deploy from
clearing it. Set/rotate a secret from the CLI with:

```
npx wrangler secret put RESEND_API_KEY -c wrangler.ivr.toml
```

## Email (Gmail "Send mail as")

Outbound email from Gmail is configured to send **as** `contact@thedomebros.com`
via Resend SMTP:
- Host `smtp.resend.com`, port **465 (SSL)** (587/TLS also works)
- Username `resend`, password = the **Resend API key**
- Requires the domain to be verified in Resend (SPF/DKIM). This is **done and
  working**, and is set as the Gmail default "from".

## Already set up / done

- Email send-as `contact@thedomebros.com` (Gmail + Resend) — working.
- "pool enclosure" keyword sprinkled across the 5 indexed pages; favicon `sizes`
  added everywhere.
- Root `/favicon.ico` added (brand mark); the old orphan `assets/favicon.ico`
  (a generic globe Google was indexing as the search-result favicon) was deleted.
- Contact page: "★ Leave us a Google review" link →
  `https://g.page/r/CUGpbJev9kG-EBM/review`.
- `assets/logo-square.png` created for the Google Business Profile logo slot.
- Google Business Profile: category **Swimming pool contractor**; services list
  and a ~750-char description drafted (GBP rejects URLs and the word "free" in
  the description).

## In progress / next

- **GBP:** upload `assets/logo-square.png` as the Logo and `assets/logo.png` as
  the Cover photo; finish profile verification (email method); the $1000 Google
  Ads credit (spend $500 in 60 days → get $1000).
- **Favicon refresh:** Google's search-result favicon can take ~1–4 weeks to
  update; use Search Console URL Inspection → Request Indexing to nudge it.
- **Reviews:** Google reviews flow through the GBP; a broader review-collection
  system was discussed but not built.

## Working conventions

- No build/test/lint tooling — it's hand-edited static HTML/CSS/JS. "Done" means
  the page renders correctly; verify by opening the file or the live URL.
- The `mockup*` files are dead prototypes; don't edit them for real changes.
- The `worker/*.js` files are the deploy source — after editing one, redeploy it
  with `npx wrangler deploy -c worker/wrangler.<name>.toml` (the change won't go
  live until you do).
