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

## Known tradeoff: free-tier speed

Render's free tier throttles CPU hard. A search that takes ~10-30s locally
took **245 seconds** on the free worker during testing - confirmed correct
results, just slow. Decision made: **staying on free tier** ($0/mo). The
deployed frontend shows a persistent "this can take a few minutes" notice
(`window.SLOW_WORKER = true` in `web/index.html`) so the wait doesn't look
like a broken app.

To upgrade later if the slowness becomes a problem: Render's cheapest paid
tier (~$7/mo, Starter) gives dedicated CPU instead of shared/throttled -
should bring it back near local speed. Change the plan on the service (API
or dashboard), then remove `window.SLOW_WORKER = true` from `web/index.html`
and redeploy (`cd web && vercel --yes` then `vercel promote <url> --yes`).

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
