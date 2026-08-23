# Deployment

## Why two hosts

Vercel's serverless functions can't run this app's core feature: every search
launches headless Chromium via Playwright, some searches run 2-3+ minutes
(World mode, picture mode), and Vercel caps Python function size at 50MB —
Playwright's Chromium alone blows past that, and the workaround
(`@sparticuz/chromium`) is Node.js-only, not Python. So:

- **Vercel** hosts the static frontend (`web/`) — this fits it well, free.
- **The worker** (Flask + Playwright + SQLite cache, everything in the repo
  root) needs an always-on host that supports Docker and long requests.

## Frontend — done

Live at **https://web-zeta-ecru-61.vercel.app** (deployed from `web/` via
`vercel --yes`). To redeploy after editing `web/index.html` or after copying
fresh `static/app.js` / `static/style.css` into `web/static/`:

```
cd web
vercel --yes
```

## Worker — needs your account, here's exactly how

Render is the recommended host: supports Docker (so Playwright's system
dependencies install correctly via the official `mcr.microsoft.com/playwright/python`
base image already set up in `Dockerfile`), and long request timeouts (set to
300s in the Dockerfile's gunicorn command). Any host that runs a Docker
container (Railway, Fly.io) works the same way if you'd rather use one of
those instead.

1. Push this repo to GitHub (git is already initialized locally, nothing
   committed yet):
   ```
   git add -A
   git commit -m "Initial commit"
   git remote add origin <your-new-github-repo-url>
   git push -u origin main
   ```
2. On Render: New → Blueprint → connect the repo. It'll read `render.yaml`
   automatically.
3. Set these env vars in Render's dashboard (marked `sync: false` in
   `render.yaml` because secrets don't belong in a committed file):
   - `OPENAI_API_KEY` — your key
   - `APP_SHARED_SECRET` — use exactly this value (already embedded in
     `web/index.html`'s `window.API_SECRET`, so the two sides match without
     you having to redeploy the frontend):
     ```
     qjFn-2LWW__8ounNZxDjcUxJYNQxL3iG
     ```
4. Deploy. Render gives you a URL like `https://creative-research-worker.onrender.com`.
5. Open `web/index.html`, replace `window.API_BASE` with that real URL, then
   redeploy the frontend (`cd web && vercel --yes`).
6. Free-tier note: Render's free web services spin down after inactivity —
   the first request after idling can take 30-60s to wake up. Fine for a
   personal research tool, worth knowing so a slow first search doesn't look
   broken.

## Security note (read this before sharing the URL)

`APP_SHARED_SECRET` stops casual/automated abuse, not a determined person —
it's embedded in `web/index.html`'s source, so anyone who views-source on the
deployed frontend can read it and call the worker directly. That's an
accepted tradeoff for a personal tool with no full login system, but don't
treat the URL as safe to post publicly: anyone with the secret can burn your
OpenAI credits and use your server to scrape Meta/TikTok/Google. Rotate
`APP_SHARED_SECRET` (regenerate, update both sides) if you ever suspect it
leaked.
