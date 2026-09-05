"""
Meta (Facebook + Instagram) ad search via the Apify "Facebook Ads Library
Scraper" actor (apify/facebook-ads-scraper), instead of scraping the
public Ad Library ourselves with Playwright.

Confirmed live (2026-09-05) that self-hosted scraping from Render's IP
range gets a filtered/reduced result set from Meta - two independent
back-to-back fresh scrapes of the identical query returned a consistent,
lower count on Render than the same query run locally, and specific
known-active advertisers (confirmed present via a direct check) were
completely absent from the Render-run results every time. This mirrors
exactly what already happened to tiktok_scrape.py (Render's IP hard-
blocked by TikTok) - Apify's actor runs on their own infra instead, which
does not hit this problem (confirmed: the same missing advertiser's ads
were found correctly via the actor). No more in-container Chromium for
Meta, so no more Chromium-concurrency/OOM concern here either.

Requires APIFY_TOKEN in the environment (from Apify Console -> Settings ->
API & Integrations -> Personal API token) - same token TikTok already
uses, since both are Apify actors.
"""

import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from urllib.parse import quote
import requests

RUN_URL = "https://api.apify.com/v2/actors/apify~facebook-ads-scraper/run-sync-get-dataset-items"

# The exact URL the old Playwright scraper used to navigate to directly -
# unchanged, just handed to the actor as a startUrls entry now instead of
# being loaded in our own browser.
SEARCH_URL = (
    "https://www.facebook.com/ads/library/?active_status=active&ad_type=all"
    "&country={country}&is_targeted_country=false&media_type=video"
    "&q={keyword}&search_type=keyword_unordered"
)

# Curated list of countries with major/emerging dropshipping ad activity.
# "Dubai" is a city, not a country - AE (United Arab Emirates) is the real
# targeting code. CN (China) is included since it was requested, but Meta
# ad delivery into mainland China is minimal (Facebook/Instagram are
# blocked there) so that leg will often come back near-empty - that's
# expected, not a bug.
WORLD_COUNTRIES = [
    "US", "GB", "AE", "CN", "IN", "AU", "CA", "SA", "DE", "PH", "ID", "BR", "MX",
]

WORLD_CONCURRENCY = 6  # plain HTTP calls to Apify, not Chromium - safe well above
                       # the old 2-instance Playwright cap


def _token():
    token = os.environ.get("APIFY_TOKEN")
    if not token:
        raise RuntimeError("APIFY_TOKEN not set")
    return token


def _post(payload, timeout_s):
    resp = requests.post(
        RUN_URL,
        headers={"Authorization": f"Bearer {_token()}"},
        json=payload,
        timeout=timeout_s,
    )
    if not resp.ok:
        raise RuntimeError(f"Apify request failed ({resp.status_code}): {resp.text[:500]}")
    items = resp.json()
    if isinstance(items, dict) and items.get("error"):
        raise RuntimeError(f"Apify actor error: {items['error']}")
    return items


def _days_running(start_date_formatted):
    if not start_date_formatted:
        return None, None
    try:
        started = datetime.fromisoformat(start_date_formatted.replace("Z", "+00:00"))
        days = (datetime.now(timezone.utc) - started).days
        return started.date().isoformat(), days
    except ValueError:
        return None, None


def _first_video(snapshot):
    """Video content lives in one of two places depending on ad format -
    confirmed live: 56/60 sampled ads used snapshot.videos[], 4/60 used
    snapshot.cards[] (carousel-style, each card can carry its own video) -
    same field names (videoHdUrl/videoSdUrl/videoPreviewImageUrl) either
    way, just nested one level differently."""
    for source in (snapshot.get("videos") or []), (snapshot.get("cards") or []):
        for item in source:
            video_url = item.get("videoHdUrl") or item.get("videoSdUrl")
            if video_url:
                return video_url, item.get("videoPreviewImageUrl")
    return None, None


def _body_text(snapshot):
    body = snapshot.get("body")
    if isinstance(body, dict):
        text = body.get("text")
        if text:
            return text
    elif isinstance(body, str) and body:
        return body
    # Carousel ads can carry the real copy per-card instead of at the top
    # level - confirmed live, one sampled ad had snapshot.body=None but
    # snapshot.cards[0].body populated.
    for card in snapshot.get("cards") or []:
        if card.get("body"):
            return card["body"]
    return ""


def _parse_item(item, country):
    snapshot = item.get("snapshot") or {}
    video_url, thumbnail = _first_video(snapshot)
    if not video_url:
        return None  # image-only ad - dashboard is video-only, matches prior behavior
    library_id = str(item.get("adArchiveID") or item.get("adArchiveId") or "") or None
    started_on, days_running = _days_running(item.get("startDateFormatted"))
    return {
        "platform": "meta",
        "advertiser": snapshot.get("pageName") or "Unknown",
        "body": _body_text(snapshot),
        "video_url": video_url,
        "thumbnail": thumbnail,
        "library_id": library_id,
        "started_on": started_on,
        "days_running": days_running,
        # "N ads use this creative and text" in the old UI - same concept,
        # this actor exposes it directly as an integer.
        "variant_count": item.get("collationCount") or 1,
        "country": country,
        "permalink": f"https://www.facebook.com/ads/library/?id={library_id}" if library_id else None,
    }


def _dedupe(ads):
    seen = set()
    out = []
    for a in ads:
        if a["library_id"] and a["library_id"] not in seen:
            seen.add(a["library_id"])
            out.append(a)
    return out


def search(keyword, country="US", results_limit=100, timeout_s=280):
    """Single-country search via the Apify actor - resultsLimit controls
    depth directly (no scroll/plateau heuristics needed, the actor handles
    its own pagination), so raising it is just a straightforward cost/
    depth tradeoff instead of a timing-sensitive guess."""
    url = SEARCH_URL.format(country=country, keyword=quote(keyword))
    items = _post({
        "startUrls": [{"url": url}],
        "resultsLimit": results_limit,
        "activeStatus": "active",
    }, timeout_s)
    ads = [_parse_item(it, country) for it in items]
    return _dedupe([a for a in ads if a])


def search_world(keyword, countries=None, results_limit_per_country=40, timeout_s=280):
    """Runs one actor call per market concurrently - plain HTTP requests,
    not Chromium instances, so there's no OOM ceiling to respect here the
    way meta_scrape.py's old Playwright version had."""
    countries = countries or WORLD_COUNTRIES
    all_ads = []
    with ThreadPoolExecutor(max_workers=min(WORLD_CONCURRENCY, len(countries))) as ex:
        futures = {
            ex.submit(search, keyword, c, results_limit_per_country, timeout_s): c
            for c in countries
        }
        for fut in as_completed(futures):
            try:
                all_ads.extend(fut.result())
            except Exception:
                continue
    return _dedupe(all_ads)
