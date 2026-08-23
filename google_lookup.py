"""
Looks up whether a given domain/advertiser runs Google ads, via the public
Ads Transparency Center. This is a "does this competitor also run Google
ads" check (advertiser accounts + a direct link), not a full creative
scraper - Google's ad previews sit behind another click-through plus a
sandboxed iframe, not worth reverse-engineering for a secondary panel.

Verified working during development: searching "nike.com" correctly landed
on the domain overview page listing its advertiser accounts.
"""

from playwright.sync_api import sync_playwright


def lookup(domain, region="US", timeout_ms=20000):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(locale="en-US")
        page.goto(f"https://adstransparency.google.com/?region={region}", timeout=timeout_ms)
        page.wait_for_timeout(2000)

        inp = page.query_selector("input")
        if not inp:
            browser.close()
            return {"domain": domain, "advertisers": [], "link": None}

        inp.fill(domain)
        page.wait_for_timeout(1500)
        suggestion = page.locator(f"text={domain}").first
        if suggestion.count() == 0:
            browser.close()
            return {"domain": domain, "advertisers": [], "link": None}

        suggestion.click()
        page.wait_for_timeout(4000)
        # ponytail: "Verified" badge text is the only stable anchor found for
        # advertiser names on this SPA; swap for a better selector if Google
        # changes the layout.
        advertisers = page.evaluate(
            """() => Array.from(document.querySelectorAll('*'))
                .filter(el => el.children.length === 0 && el.innerText === 'Verified')
                .map(el => el.previousElementSibling ? el.previousElementSibling.innerText : null)
                .filter(Boolean)"""
        )
        link = page.url
        browser.close()

    return {"domain": domain, "advertisers": advertisers, "link": link}
