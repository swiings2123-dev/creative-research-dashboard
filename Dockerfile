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
# -w 1: one process - each request may hold a full Chromium instance in
# memory, more processes needs proportionally more RAM on whatever plan
# runs this.
# --worker-class gthread --threads 4: confirmed root cause of a real bug -
# with the default sync worker, a single long /search request (which can
# run 15-90s+) fully occupies the one worker, so Render's periodic health-
# check ping to "/" gets no response, Render decides the instance is dead,
# and restarts it mid-request (reproduced twice: container restarts ~46s
# into a request, client sees a 502). Threads let this one process answer
# a trivial health-check GET while a slow POST is in flight, without
# spawning a second OS process (which would double baseline memory).
CMD gunicorn -w 1 --worker-class gthread --threads 4 -b 0.0.0.0:$PORT --timeout 300 app:app
