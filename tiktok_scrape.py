"""
TikTok ad search via the Apify "TikTok Ads Scraper" actor
(lexis-solutions/tiktok-ads-scraper), instead of scraping TikTok Creative
Center ourselves - that page returned a hard HTTP 403 from Render's IP
range (confirmed via diagnostics, survived multiple redeploys/IP changes),
so self-hosted scraping was a dead end. Apify runs the scrape on their own
infra, so it isn't affected by that block - and as a bonus, no Chromium
instance needs to run in our own container for TikTok anymore.

Requires APIFY_TOKEN in the environment (from Apify Console -> Settings ->
API & Integrations -> Personal API token).
"""

import os
import requests

RUN_URL = "https://api.apify.com/v2/actors/lexis-solutions~tiktok-ads-scraper/run-sync-get-dataset-items"


def search(keyword, max_pages=1, timeout_s=180):
    token = os.environ.get("APIFY_TOKEN")
    if not token:
        raise RuntimeError("APIFY_TOKEN not set")

    resp = requests.post(
        RUN_URL,
        params={"token": token},
        json={
            "query": keyword,
            "maxPages": max_pages,
            "country": "all",
            "quickSearch": True,
        },
        timeout=timeout_s,
    )
    resp.raise_for_status()
    items = resp.json()
    if isinstance(items, dict) and items.get("error"):
        raise RuntimeError(f"Apify TikTok actor error: {items['error']}")

    results = []
    for it in items:
        video_url = it.get("adVideoUrl")
        if not video_url:
            continue  # image-only ad - dashboard is video-only
        results.append({
            "platform": "tiktok",
            "advertiser": it.get("adTitle") or None,
            "body": None,
            "video_url": video_url,
            "thumbnail": it.get("adVideoCover") or None,
            "days_running": None,
            "permalink": None,
            "library_id": it.get("adId"),
        })
    return results
