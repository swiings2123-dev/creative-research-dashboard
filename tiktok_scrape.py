"""
TikTok ad search via two separate Apify actors, instead of scraping TikTok
Creative Center ourselves - that page returned a hard HTTP 403 from
Render's IP range (confirmed via diagnostics, survived multiple redeploys/
IP changes), so self-hosted scraping was a dead end. Apify runs the scrape
on their own infra, so it isn't affected by that block.

Requires APIFY_TOKEN in the environment (from Apify Console -> Settings ->
API & Integrations -> Personal API token).

Two actors, two very different country scopes - both confirmed live, not
assumed from docs (the docs' human-readable country/option lists didn't
match what the API actually accepts):

- lexis-solutions/tiktok-ads-scraper (RUN_URL, via search()): TikTok's EU
  Ads Transparency Repository - a legal disclosure database, EU/EEA + UK
  + Switzerland only (confirmed via a live 400: the actor rejects every
  other country code, "all" meaning "all covered EU/UK/CH countries", not
  worldwide). Not usable for a real "what's viral in the US/India/etc"
  signal - it structurally can't see those markets at all.
- lexis-solutions/tiktok-top-ads-scraper (TOP_ADS_RUN_URL, via
  search_top_ads()): TikTok's Creative Center Top Ads dashboard - much
  broader real-world coverage (~80 countries including US, GB, DE, BR,
  ID...) but confirmed live to NOT include India in its allowed country
  values at all, and no ad's countryCodes list ever contains "IN" either -
  consistent with TikTok ads simply not running in India.
"""

import os
import requests

RUN_URL = "https://api.apify.com/v2/actors/lexis-solutions~tiktok-ads-scraper/run-sync-get-dataset-items"
TOP_ADS_RUN_URL = "https://api.apify.com/v2/actors/lexis-solutions~tiktok-top-ads-scraper/run-sync-get-dataset-items"

# lexis-solutions/tiktok-ads-scraper's allowed `country` values, confirmed
# live via a 400 error listing them - EU/EEA + UK + Switzerland only.
MAIN_ACTOR_COUNTRIES = {
    "FR", "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "DE", "GR",
    "HU", "IS", "IE", "IT", "LV", "LI", "LT", "LU", "MT", "NL", "NO", "PL",
    "PT", "RO", "SK", "SI", "ES", "SE", "CH", "GB",
}

# lexis-solutions/tiktok-top-ads-scraper's allowed `country` values,
# confirmed live via a 400 error listing them. Notably excludes India.
TOP_ADS_COUNTRIES = {
    "DZ", "AR", "AU", "AT", "AZ", "BH", "BD", "BY", "BE", "BO", "BR", "BG",
    "KH", "CA", "CL", "CO", "CR", "HR", "CY", "CZ", "DK", "DO", "EC", "EG",
    "EE", "FI", "FR", "DE", "GR", "GT", "JO", "HU", "ID", "IQ", "IE", "IL",
    "IT", "JP", "KZ", "KE", "KW", "LV", "LB", "MY", "MX", "MA", "NL", "NZ",
    "NG", "NO", "OM", "PK", "PA", "PY", "PE", "PH", "PL", "PT", "PR", "QA",
    "LT", "RO", "SA", "RS", "SG", "SK", "SI", "ZA", "KR", "ES", "LK", "SE",
    "CH", "TW", "TH", "TR", "AE", "GB", "US", "UY", "VN",
}


def _token():
    token = os.environ.get("APIFY_TOKEN")
    if not token:
        raise RuntimeError("APIFY_TOKEN not set")
    return token


def _post(url, payload, timeout_s):
    # Bearer header, not a ?token= query param - requests/urllib3 (and
    # anything that logs or re-raises the request URL, including a plain
    # HTTPError's default message) would otherwise put the live token in
    # plaintext wherever that error surfaces.
    resp = requests.post(
        url,
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


def search(keyword, country="all", max_pages=1, timeout_s=180):
    # This actor only covers the EU/EEA + UK/CH transparency database (see
    # module docstring) - most of this app's country dropdown (US, IN, AE,
    # CN, AU, CA, SA, PH, ID, BR, MX) isn't a valid value here at all, and
    # sending one anyway is a hard 400. Falls back to "all" for anything
    # unsupported instead of erroring out the whole /search request over a
    # country this actor was never going to have data for regardless.
    actor_country = country if country in MAIN_ACTOR_COUNTRIES else "all"
    items = _post(RUN_URL, {
        "query": keyword,
        "maxPages": max_pages,
        "country": actor_country,
        "quickSearch": True,
    }, timeout_s)

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


def search_top_ads(country, period_days=7, order_by="like", max_items=50, timeout_s=180):
    """Browses TikTok Creative Center's Top Ads feed via a separate,
    purpose-built Apify actor - no keyword needed, ranked directly by
    engagement.

    `country` must be one of TOP_ADS_COUNTRIES (raises otherwise) -
    notably that set doesn't include India, so this can't be a "what's
    trending in India" source. Instead the International Product Finder
    calls this per major *international* market, where every result is
    structurally guaranteed to have zero India presence already - no
    separate India check needed for the TikTok leg.

    A keyword-less request still needs an anchor - confirmed via the
    actor's own worked example (its docs' "keyword is optional" note
    means "provide startUrls instead", not "omit both"): startUrls must
    point at the actual Creative Center Top Ads page, and orderBy/period
    take internal codes confirmed live via a 400 error listing them
    ("like"/"for_you"/"ctr"/"impression"/"play_2s_rate"/"play_6s_rate"/
    "cvr", not "Likes"/"For You"; a plain day-count string, not "Last 7
    days"), not the display labels shown in Apify's UI dropdowns.
    """
    if country not in TOP_ADS_COUNTRIES:
        raise ValueError(f"TikTok Top Ads doesn't support country={country!r} (not in TOP_ADS_COUNTRIES)")

    start_url = (
        "https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en"
        f"?period={period_days}&region={country}"
    )
    items = _post(TOP_ADS_RUN_URL, {
        "startUrls": [{"url": start_url}],
        "country": [country],
        "orderBy": order_by,
        "period": str(period_days),
        "maxItems": max_items,
    }, timeout_s)

    results = []
    for it in items:
        # videoUrls is a dict keyed by resolution (e.g. {"720p": "..."}),
        # confirmed via a live call - not a list, despite how it reads.
        video_urls = it.get("videoUrls") or {}
        video_url = next(iter(video_urls.values()), None) if isinstance(video_urls, dict) else (video_urls[0] if video_urls else None)
        if not video_url:
            continue
        likes = it.get("likes") or 0
        results.append({
            "platform": "tiktok",
            "advertiser": it.get("brandName") or None,
            "body": it.get("title") or None,
            "video_url": video_url,
            "thumbnail": it.get("videoCover") or None,
            "days_running": None,
            "permalink": None,
            "library_id": it.get("id"),
            "likes": likes,
            "evidence": f"🔥 Top ad in {country} · {likes:,} likes (TikTok ads don't run in India)" if likes else f"🔥 Top ad in {country} (TikTok ads don't run in India)",
        })
    return results
