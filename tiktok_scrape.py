"""
Best-effort scrape of TikTok Creative Center's public Top Ads page.

UNTESTED: TikTok's domain (ads.tiktok.com) was unreachable from the dev
network this was built on (connection timed out on both curl and
Playwright - looked like a network/firewall block, not a code issue).
The URL pattern and DOM extraction below are based on documented site
structure only. Verify this actually returns results once you run it;
if TikTok changed their markup, this will just return [] (caught in
app.py) instead of breaking the rest of the search.
"""

from urllib.parse import quote
from playwright.sync_api import sync_playwright

SEARCH_URL = (
    "https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en"
    "?period=180&keyword={keyword}"
)


def search(keyword, timeout_ms=20000):
    url = SEARCH_URL.format(keyword=quote(keyword))
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(locale="en-US")
        page.goto(url, timeout=timeout_ms)
        page.wait_for_timeout(5000)
        cards = page.evaluate(
            """() => Array.from(document.querySelectorAll('video')).map(v => ({
                src: v.getAttribute('src'),
                poster: v.getAttribute('poster'),
            }))"""
        )
        browser.close()

    return [
        {
            "platform": "tiktok",
            "advertiser": None,
            "body": None,
            "video_url": c["src"],
            "thumbnail": c["poster"],
            "days_running": None,
            "permalink": url,
        }
        for c in cards
        if c["src"]
    ]
