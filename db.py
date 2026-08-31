import sqlite3
import json
import os
import time
from datetime import date

DB_PATH = os.path.join(os.path.dirname(__file__), "data.db")


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS search_cache (
            source TEXT, keyword TEXT, country TEXT, search_date TEXT,
            results_json TEXT,
            PRIMARY KEY (source, keyword, country, search_date)
        )"""
    )
    # Products the user has deliberately adopted for dropshipping - marked
    # via an explicit "Mark as used" click, never auto-marked just because a
    # finder run displayed them. Keyed by the same external id each scraper
    # already produces (Meta's library_id, TikTok's adId/top-ads id).
    conn.execute(
        """CREATE TABLE IF NOT EXISTS used_products (
            platform TEXT NOT NULL, external_id TEXT NOT NULL, marked_at TEXT NOT NULL,
            PRIMARY KEY (platform, external_id)
        )"""
    )
    # Product Finder runs take minutes (deep Meta/TikTok sweeps), far past
    # gunicorn's request timeout - they run on a background thread and this
    # table is how /finder/status polls for progress. epoch floats (not the
    # search_cache table's ISO-date convention) since staleness detection
    # needs sub-minute arithmetic, not calendar-day bucketing.
    conn.execute(
        """CREATE TABLE IF NOT EXISTS finder_jobs (
            job_id TEXT PRIMARY KEY, mode TEXT NOT NULL, status TEXT NOT NULL,
            progress TEXT, results_json TEXT, error TEXT,
            created_at REAL NOT NULL, updated_at REAL NOT NULL
        )"""
    )
    conn.commit()
    conn.close()


def get_cached(source, keyword, country):
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute(
        "SELECT results_json FROM search_cache WHERE source=? AND keyword=? AND country=? AND search_date=?",
        (source, keyword.lower(), country, date.today().isoformat()),
    ).fetchone()
    conn.close()
    return json.loads(row[0]) if row else None


def set_cached(source, keyword, country, results):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT OR REPLACE INTO search_cache VALUES (?,?,?,?,?)",
        (source, keyword.lower(), country, date.today().isoformat(), json.dumps(results)),
    )
    conn.commit()
    conn.close()


def mark_used(platform, external_id):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT OR IGNORE INTO used_products VALUES (?,?,?)",
        (platform, external_id, date.today().isoformat()),
    )
    conn.commit()
    conn.close()


def get_used_ids(platform):
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT external_id FROM used_products WHERE platform=?", (platform,)
    ).fetchall()
    conn.close()
    return {r[0] for r in rows}


def create_job(job_id, mode):
    conn = sqlite3.connect(DB_PATH)
    now = time.time()
    conn.execute(
        "INSERT INTO finder_jobs (job_id, mode, status, progress, results_json, error, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (job_id, mode, "running", "starting...", None, None, now, now),
    )
    conn.commit()
    conn.close()


def update_job_progress(job_id, progress_text):
    # Best-effort only: a finder job's two phases (Meta on the main thread,
    # TikTok on a second thread - see finder.py) can both write a progress
    # update to this same row at nearly the same moment, and a transient
    # SQLite "database is locked" here must never abort an otherwise-fine
    # multi-minute scrape over losing a cosmetic status line.
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.execute(
            "UPDATE finder_jobs SET progress=?, updated_at=? WHERE job_id=?",
            (progress_text, time.time(), job_id),
        )
        conn.commit()
        conn.close()
    except sqlite3.Error:
        pass


def finish_job(job_id, results, notes=None):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "UPDATE finder_jobs SET status='done', results_json=?, updated_at=? WHERE job_id=?",
        (json.dumps({"results": results, "notes": notes or []}), time.time(), job_id),
    )
    conn.commit()
    conn.close()


def fail_job(job_id, error_text):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "UPDATE finder_jobs SET status='error', error=?, updated_at=? WHERE job_id=?",
        (error_text, time.time(), job_id),
    )
    conn.commit()
    conn.close()


def _row_to_job(row):
    if row is None:
        return None
    keys = ["job_id", "mode", "status", "progress", "results_json", "error", "created_at", "updated_at"]
    return dict(zip(keys, row))


def get_job(job_id):
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute(
        "SELECT job_id, mode, status, progress, results_json, error, created_at, updated_at "
        "FROM finder_jobs WHERE job_id=?",
        (job_id,),
    ).fetchone()
    conn.close()
    return _row_to_job(row)


def get_running_job():
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute(
        "SELECT job_id, mode, status, progress, results_json, error, created_at, updated_at "
        "FROM finder_jobs WHERE status='running' ORDER BY created_at DESC LIMIT 1"
    ).fetchone()
    conn.close()
    return _row_to_job(row)
