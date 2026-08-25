"""
Scrapes the public Meta Ad Library website (facebook.com/ads/library).

Not the official Graph API - that endpoint only returns political/issue/
special-category ads, not ordinary commercial ads (confirmed by testing).
The public website has the real commercial ad data, free, no login.
Verified working against a live search during development.
"""

import re
from datetime import datetime, date
from urllib.parse import quote
from playwright.sync_api import sync_playwright

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

# Standard headless-in-Docker flags: don't touch network/page behavior (so
# they can't cause the "blocked media hides the card" bug the resource-
# blocking attempt hit), only Chromium's own internal resource use. Real
# lever for the production OOM/mid-request-restart crash: --disable-dev-
# shm-usage avoids the tiny default /dev/shm size Docker containers get
# (a very common headless-Chromium-in-Docker crash cause), --disable-gpu
# skips GPU process overhead that's dead weight with no GPU in the
# container anyway.
CHROMIUM_ARGS = ["--disable-dev-shm-usage", "--disable-gpu"]

# ponytail: DOM walk finds the ad-card boundary by watching innerText length
# jump sharply once we cross from a single card into the results grid.
# Facebook's class names are hashed/unstable, this text-based heuristic is
# the durable part. If Facebook changes the "Library ID" / "Started running
# on" wording, update the regexes in _parse_card below.
CARD_EXTRACT_JS = """
() => {
    const videos = Array.from(document.querySelectorAll('video'));
    const results = [];
    for (const v of videos) {
        let node = v;
        let prevLen = 0;
        let chosen = null;
        for (let i = 0; i < 20 && node; i++) {
            const len = (node.innerText || '').length;
            if (len > 0 && node.innerText.includes('Library ID')) {
                if (prevLen > 0 && len > prevLen * 4 && chosen) break;
                chosen = node;
                prevLen = len;
            }
            node = node.parentElement;
        }
        if (chosen) {
            results.push({
                text: chosen.innerText,
                src: v.getAttribute('src'),
                poster: v.getAttribute('poster'),
            });
        }
    }
    return results;
}
"""


def _parse_days_running(text):
    m = re.search(r"Started running on (\d{1,2} \w+ \d{4})", text)
    if not m:
        return None, None
    try:
        started = datetime.strptime(m.group(1), "%d %b %Y").date()
        return m.group(1), (date.today() - started).days
    except ValueError:
        return m.group(1), None


def _parse_card(card, country):
    text = card["text"]
    lib_id = re.search(r"Library ID: (\d+)", text)
    started_str, days_running = _parse_days_running(text)
    advertiser_match = re.search(r"\n([^\n]+)\nSponsored\n", text)
    advertiser = advertiser_match.group(1) if advertiser_match else "Unknown"
    body_match = re.search(r"Sponsored\n(.+?)\n0:00", text, re.S)
    body = body_match.group(1).strip() if body_match else ""
    # "N ads use this creative and text" - a scale signal: the more variants
    # running with the same creative, the harder this angle is being pushed.
    variant_match = re.search(r"(\d+) ads? use this creative and text", text)
    variant_count = int(variant_match.group(1)) if variant_match else 1
    return {
        "platform": "meta",
        "advertiser": advertiser,
        "body": body,
        "video_url": card["src"],
        "thumbnail": card["poster"],
        "library_id": lib_id.group(1) if lib_id else None,
        "started_on": started_str,
        "days_running": days_running,
        "variant_count": variant_count,
        "country": country,
        "permalink": (
            f"https://www.facebook.com/ads/library/?id={lib_id.group(1)}" if lib_id else None
        ),
    }


def _scroll_until_plateau(page, max_scrolls, plateau_rounds=3, wait_ms=1500):
    prev_count = 0
    stale = 0
    for _ in range(max_scrolls):
        page.mouse.wheel(0, 4000)
        page.wait_for_timeout(wait_ms)
        count = page.evaluate("document.querySelectorAll('video').length")
        if count <= prev_count:
            stale += 1
            if stale >= plateau_rounds:
                break
        else:
            stale = 0
        prev_count = count
    return prev_count


# Tried blocking video/image network requests to cut Chromium's memory
# footprint (we only read the src/poster URL *attributes*, never the actual
# bytes) - reverted: confirmed the page's own JS hides/unmounts an ad card
# when its video fails to load (an error-handling UX pattern), so blocking
# "media" alone dropped a reliable 80-94 result search to 0. Real bug, not
# a maybe - reproduced twice. Do not re-add without re-verifying against a
# live search that results still come back non-empty.
def _new_page(browser):
    return browser.new_page(locale="en-US")


def _search_one(page, keyword, country, max_scrolls, timeout_ms):
    url = SEARCH_URL.format(country=country, keyword=quote(keyword))
    page.goto(url, timeout=timeout_ms)
    # Wait for an actual video to render rather than a fixed delay - a fixed
    # 4s was fine on a fast dev machine but came back empty on a slower free
    # -tier CPU (confirmed: same page needed ~12s there). If truly zero
    # video ads exist for this query, this just falls through after the
    # timeout with nothing to find.
    try:
        page.wait_for_selector("video", timeout=15000)
    except Exception:
        pass
    _scroll_until_plateau(page, max_scrolls)
    cards = page.evaluate(CARD_EXTRACT_JS)
    return [_parse_card(c, country) for c in cards]


def _dedupe(cards):
    seen = set()
    out = []
    for c in cards:
        if c["library_id"] and c["library_id"] not in seen:
            seen.add(c["library_id"])
            out.append(c)
    return out


def search(keyword, country="US", max_scrolls=12, timeout_ms=30000):
    """Deep single-country search: scrolls until no new ads load."""
    with sync_playwright() as p:
        browser = p.chromium.launch(args=CHROMIUM_ARGS)
        page = _new_page(browser)
        cards = _search_one(page, keyword, country, max_scrolls, timeout_ms)
        browser.close()
    return _dedupe(cards)


def search_world(keyword, countries=None, max_scrolls_per_country=6, timeout_ms=30000):
    """Loops the same keyword across major dropshipping markets, one shared
    browser instance (re-launching Chromium per country is the expensive
    part, not navigation). Runs sequentially - a full world pass over ~13
    countries takes a couple of minutes; that's the accepted tradeoff for
    "search everywhere" instead of building out real parallel workers."""
    countries = countries or WORLD_COUNTRIES
    all_cards = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=CHROMIUM_ARGS)
        page = _new_page(browser)
        for country in countries:
            try:
                all_cards.extend(
                    _search_one(page, keyword, country, max_scrolls_per_country, timeout_ms)
                )
            except Exception:
                continue
        browser.close()
    return _dedupe(all_cards)
