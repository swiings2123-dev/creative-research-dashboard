import sqlite3
import json
import os
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
