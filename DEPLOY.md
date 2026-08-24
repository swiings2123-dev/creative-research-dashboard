# Deployment

## Status: live

- **Frontend**: https://web-zeta-ecru-61.vercel.app (Vercel, static)
- **Worker**: https://creative-research-worker.onrender.com (Render, free tier, Docker)
- **Source**: https://github.com/swiings2123-dev/creative-research-dashboard

## Why two hosts

Vercel's serverless functions can't run this app's core feature: every search
launches headless Chromium via Playwright, some searches run 2-3+ minutes
(World mode, picture mode), and Vercel caps Python function size at 50MB —
Playwright's Chromium alone blows past that, and the workaround
(`@sparticuz/chromium`) is Node.js-only, not Python. So Vercel hosts the
static frontend only; the worker (Flask + Playwright + SQLite cache) runs on
Render, which supports Docker and long request timeouts.

## Status: upgraded to Starter (~16s/search, confirmed)

Started on free tier, which throttled CPU hard enough that a plain search
took 245s (vs ~10-30s locally) and a deploy once failed outright (gunicorn
took 4 min to boot, Render's port scanner gave up after 11 more minutes -
classic resource starvation, not a code bug). Upgraded the service to
Render's **Starter** plan via the API once a payment method was added to
the account - confirmed via direct test: a fresh search now takes **~16s**,
matching local speed. `window.SLOW_WORKER` is now `false` in
`web/index.html` accordingly. Render's pricing is workspace-plan-based now
(not a flat ~$7/mo per service like it used to be) - check the account's
actual Render billing page for the current total, since that changes.

World mode (multi-country) and picture-mode (per-ad vision API calls) are
still genuinely slow regardless of instance tier - that's inherent to doing
more scraping/API work, not CPU throttling, so the frontend still shows a
"this takes a few minutes" notice for those two specifically.

## "At least 50 creatives" - auto-boost

A single-country Meta search that comes up short of 50 results
automatically tops up from a few more markets (GB, CA, AU) before
returning - see `MIN_TARGET_RESULTS` / `BOOST_COUNTRIES` in `app.py`. Most
searches never trigger this (already 50+ from one country); confirmed live:
a thin keyword ("portable blender") went 24 (US) -> 51 (US+GB+CA) in ~50s.

## TikTok: confirmed blocked, not a bug to keep chasing

TikTok Creative Center returns **HTTP 403** (a ~39-byte empty page) to
Render's server IP - confirmed via direct diagnostic. This is TikTok
actively blocking datacenter/cloud traffic, not a wrong selector or a
parsing issue. Getting past that properly requires paid residential
proxies (real recurring cost), which wasn't in scope for a "cheapest way"
build - the TikTok checkbox is disabled in the UI with an explanation
rather than silently failing. Instagram video ads are NOT similarly
missing - they're already included in every Meta result, since Instagram
ads are served from the same Meta Ad Library (Facebook + Instagram +
Messenger all one system), no separate integration needed.

## Redeploying after changes

**Frontend** (after editing `web/index.html`, or after `static/app.js` /
`static/style.css` change - copy them into `web/static/` first):
```
cd web
vercel --yes
vercel promote <the preview URL it prints> --yes
```

**Worker** (after editing any root-level Python file): just `git push` -
`autoDeploy` is on, Render redeploys automatically on every push to `master`.
To force one immediately without waiting for the webhook:
```
curl -X POST -H "Authorization: Bearer <RENDER_API_KEY>" \
  -H "Content-Type: application/json" \
  https://api.render.com/v1/services/srv-da5h0f0jo6nc73chnko0/deploys -d '{}'
```

## Security note (read this before sharing the URL)

`APP_SHARED_SECRET` stops casual/automated abuse, not a determined person —
it's embedded in `web/index.html`'s source, so anyone who views-source on the
deployed frontend can read it and call the worker directly. That's an
accepted tradeoff for a personal tool with no full login system, but don't
treat the URL as safe to post publicly: anyone with the secret can burn your
OpenAI credits and use your server to scrape Meta/TikTok/Google. Rotate it
(regenerate, update both the Render env var and `web/index.html`, redeploy
both sides) if you ever suspect it leaked. Current value is in the Render
dashboard's env vars and in `web/index.html` - not repeated here since this
file is public in the repo.
