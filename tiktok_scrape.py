"""
Best-effort scrape of TikTok Creative Center's public Top Ads page.

TikTok's domain is unreachable from some networks (including the dev
machine and Anthropic's own WebFetch infra - both connection-refused/
timed-out on this URL), but IS reachable from the deployed Render worker.
When Chromium loads the page there but finds zero videos, this raises a
descriptive error (page title + body length + button/consent-wall hints)
instead of silently returning [] - that diagnostic surfaces in the
worker's JSON response ("errors" field) so the real cause (consent wall,
region gate, wrong selector, TikTok requires login, etc) is visible
without needing direct network access to TikTok to debug it.
"""

from urllib.parse import quote
from playwright.sync_api import sync_playwright

CHROMIUM_ARGS = ["--disable-dev-shm-usage", "--disable-gpu"]

SEARCH_URL = (
    "https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en"
    "?period=180&keyword={keyword}"
)

# Common cookie-consent / region-gate button text seen on TikTok's business
# pages - clicked if present, ignored if not.
_DISMISS_TEXTS = ["Accept all", "Accept All", "I Accept", "Got it", "Allow all"]


def search(keyword, timeout_ms=25000):
    url = SEARCH_URL.format(keyword=quote(keyword))
    with sync_playwright() as p:
        browser = p.chromium.launch(args=CHROMIUM_ARGS)
        page = browser.new_page(locale="en-US", viewport={"width": 1440, "height": 900})
        response = page.goto(url, timeout=timeout_ms)
        resp_status = response.status if response else None
        resp_url = page.url

        for text in _DISMISS_TEXTS:
            try:
                page.get_by_text(text, exact=False).first.click(timeout=1500)
                break
            except Exception:
                pass

        try:
            page.wait_for_selector("video", timeout=15000)
        except Exception:
            pass
        page.wait_for_timeout(2000)

        cards = page.evaluate(
            """() => Array.from(document.querySelectorAll('video')).map(v => ({
                src: v.getAttribute('src'),
                poster: v.getAttribute('poster'),
            }))"""
        )

        if not cards:
            diag = page.evaluate(
                """() => ({
                    title: document.title,
                    bodyLen: document.body.innerText.length,
                    bodySnippet: document.body.innerText.slice(0, 300),
                    videoTagCount: document.querySelectorAll('video').length,
                    iframeCount: document.querySelectorAll('iframe').length,
                    htmlLen: document.documentElement.outerHTML.length,
                })"""
            )
            diag["httpStatus"] = resp_status
            diag["finalUrl"] = resp_url
            browser.close()
            raise RuntimeError(f"0 videos found - page diagnostic: {diag}")

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
