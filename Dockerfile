# Playwright's official image ships Chromium + every system library it needs
# already installed correctly - trying to `playwright install` on a generic
# python:slim image is the #1 way this breaks on a fresh host (missing
# libnspr4/libnss3 etc.), so this avoids that class of problem entirely.
FROM mcr.microsoft.com/playwright/python:v1.62.0-jammy

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

COPY . .

ENV PORT=8000
EXPOSE 8000

# --timeout 300: World-mode and picture-mode searches run several minutes -
# gunicorn's 30s default worker timeout would kill them mid-request.
# -w 1: one process. Originally set because every Meta/TikTok request held
# a full Chromium instance in memory - Meta and TikTok are both plain
# Apify HTTP calls now (see meta_scrape.py/tiktok_scrape.py), so that's no
# longer true for them; google_lookup.py's separate domain-lookup feature
# is the only remaining Chromium user, and it's called far less often than
# /search. Left at 1 for now rather than bundled into an unrelated bugfix
# pass - revisit if throughput under concurrent /search + /finder load
# actually becomes a bottleneck.
# --worker-class gthread --threads 4: with the default sync worker, a
# single long /search request fully occupies the one worker, so Render's
# health-check ping to "/" gets no response during it. Threads let this
# one process answer that while a slow POST is in flight, without a
# second OS process (which would double baseline memory).
# --max-requests 1000 --max-requests-jitter 200: gunicorn recycles this
# worker process every ~800-1200 requests instead of running it forever.
# Mitigates a real production incident: after dozens of requests in one
# long-lived process, the whole service crash-looped (even plain GET /
# started 502ing) - consistent with Chromium subprocesses not fully
# releasing back to the OS across requests and slowly exhausting the
# container. Raised from the original 15/5 when Product Finder's
# /finder/status polling landed (finder.py, ~4s interval over a run that
# can take 20+ minutes = 300-450 polls per job) - that endpoint only reads
# a SQLite row, no Chromium involved, so it doesn't reintroduce the leak;
# the old threshold just meant a routine recycle killed the *unrelated*
# background thread doing the actual scrape mid-job, orphaning it. Root
# cause of the original leak is still not nailed down; this still bounds
# the damage from Chromium-heavy requests, just at a volume that survives
# one finder job's polling instead of getting hit by it within a minute.
CMD gunicorn -w 1 --worker-class gthread --threads 4 --max-requests 1000 --max-requests-jitter 200 -b 0.0.0.0:$PORT --timeout 300 app:app
