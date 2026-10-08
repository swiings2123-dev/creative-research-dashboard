"""
Turns a product link and/or product photo into a clean ad-library search
query, and (when a reference product image is available) visually verifies
that a candidate ad thumbnail actually shows the same product.

Product pages are loaded with a real browser (Playwright), not a plain
HTTP GET - confirmed live (2026-09-16) that Amazon.in actively blocks
plain requests.get() with a deliberate bot-detection page (title is
literally "Amazon.in", no real content, an explicit "automated access"
notice in the HTML) rather than erroring out, so the old code silently
resolved every Amazon link to the brand name instead of the actual
product - not a wrong-but-recoverable response, a different page
entirely. A real browser context gets the genuine product page instead
(confirmed against a live Amazon.in listing). Most other storefronts
(Shopify etc.) don't need this, but there's no reliable way to know
which sites do without trying, and a browser fetch works for both.
"""

import os
import base64
from html.parser import HTMLParser
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from openai import OpenAI
from playwright.sync_api import sync_playwright

_client = None

# Confirmed live (2026-09-05): this account's models need the regional
# endpoint - the default api.openai.com host 401s on gpt-6-astra with
# "Attempted to access resource with incorrect regional hostname. Please
# make your request to us.api.openai.com" - and the older models (gpt-4o)
# work fine against this same host too, so there's no need to branch
# per-model.
_API_BASE_URL = "https://us.api.openai.com/v1"


def _get_client():
    global _client
    if _client is None:
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY not set - add it to .env")
        _client = OpenAI(api_key=api_key, base_url=_API_BASE_URL)
    return _client


class _OGParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = {}
        self.title = None
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta":
            prop = attrs.get("property") or attrs.get("name")
            if prop in ("og:title", "og:description", "og:image", "twitter:title", "twitter:image"):
                self.tags[prop] = attrs.get("content")
        elif tag == "title":
            self._in_title = True

    def handle_data(self, data):
        if self._in_title and self.title is None:
            self.title = data.strip()

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False


# Sites that don't expose og:image/twitter:image at all - confirmed live
# that Amazon.in is one of these (no image meta tags whatsoever) - fall
# back to the actual product-image element on the page.
_FALLBACK_IMAGE_SELECTORS = [
    "#landingImage",         # Amazon
    "#imgTagWrapperId img",  # Amazon, alternate layout
]

_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def fetch_product_page(url, timeout_ms=30000):
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--disable-dev-shm-usage", "--disable-gpu"])
        page = browser.new_page(locale="en-US", user_agent=_BROWSER_USER_AGENT)
        page.goto(url, timeout=timeout_ms)
        # Fixed wait, not wait_for_selector - the target elements differ
        # per site (this function is used on arbitrary storefront URLs),
        # so there's no one selector to wait on; this only needs enough
        # time for the page's own JS to finish rendering title/image
        # content into the DOM before reading it.
        page.wait_for_timeout(1500)
        html = page.content()

        parser = _OGParser()
        parser.feed(html[:400000])

        image_url = parser.tags.get("og:image") or parser.tags.get("twitter:image")
        if not image_url:
            for selector in _FALLBACK_IMAGE_SELECTORS:
                try:
                    image_url = page.eval_on_selector(selector, "el => el.src")
                except Exception:
                    continue
                if image_url:
                    break

        browser.close()

    return {
        "title": parser.tags.get("og:title") or parser.tags.get("twitter:title") or parser.title,
        "description": parser.tags.get("og:description"),
        "image_url": image_url,
    }


def image_to_keyword(image_bytes, mime="image/jpeg"):
    b64 = base64.b64encode(image_bytes).decode()
    resp = _get_client().chat.completions.create(
        # Deliberately NOT the flagship OPENAI_VISION_MODEL (gpt-6-astra) -
        # confirmed live that model only accepts its default temperature
        # (1, no override allowed), which made this step generate a
        # meaningfully different search phrase almost every call ("Toy
        # smartphone for kids" vs "Kids toy phone" vs "Toy phone for
        # kids"...), and since Meta's keyword search is very sensitive to
        # exact wording (confirmed repeatedly this session - identical
        # products, different phrasing, wildly different result counts:
        # 100 vs 3 vs 0), that variance directly broke this feature's
        # reliability. This step just needs "what is this product," not
        # maximum reasoning power - gpt-4o with temperature=0.2 (its
        # original config) gives back a consistent, boring phrasing every
        # time, which is exactly what a text search needs.
        model="gpt-4o",
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": (
                    "What specific product is shown? Reply with ONLY a concise "
                    "2-5 word search query for this product category (no brand names)."
                )},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
            ],
        }],
        max_completion_tokens=20,
        temperature=0.2,
    )
    return resp.choices[0].message.content.strip()


def synthesize_query(keyword=None, product_title=None, image_keyword=None):
    parts = [p for p in [keyword, image_keyword, product_title] if p]
    if len(parts) <= 1:
        return parts[0] if parts else None
    resp = _get_client().chat.completions.create(
        model="gpt-4o",  # same reasoning as image_to_keyword above
        messages=[{
            "role": "user",
            "content": (
                "These all describe the same product, from different sources: "
                + " | ".join(parts)
                + ". Reply with ONLY one concise 2-5 word search query that best "
                "captures the product category, suitable for searching an ad library."
            ),
        }],
        max_completion_tokens=20,
        temperature=0.2,
    )
    return resp.choices[0].message.content.strip()


def _guess_mime(content_type_header, fallback="image/jpeg"):
    if not content_type_header:
        return fallback
    return content_type_header.split(";")[0].strip() or fallback


def _fetch_image_b64(url, timeout=10):
    resp = requests.get(url, timeout=timeout, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    mime = _guess_mime(resp.headers.get("Content-Type"))
    return base64.b64encode(resp.content).decode(), mime


def _images_match(reference_b64, reference_mime, candidate_url):
    try:
        candidate_b64, candidate_mime = _fetch_image_b64(candidate_url)
    except Exception:
        return False
    try:
        resp = _get_client().chat.completions.create(
            model=os.environ.get("OPENAI_VISION_MODEL", "gpt-6-astra"),
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": (
                        "The first image is a reference product photo. The second "
                        "image is a still frame from an ad video. Is the SPECIFIC "
                        "same product physically shown in both - same item design, "
                        "not just the same general category (e.g. two different "
                        "posture correctors, or two different kids' toy phones, "
                        "must be answered 'no' even though they're the same type "
                        "of product) - allowing for different angle, color "
                        "variant, lighting, or background? Confirmed live: Meta's "
                        "video thumbnails are sometimes a blank/black loading-"
                        "glitch frame instead of a real product frame - if either "
                        "image is blank, solid-black, too dark, or otherwise "
                        "doesn't clearly show a product, reply 'unclear' rather "
                        "than guessing 'no'. Reply with ONLY one word: yes, no, "
                        "or unclear."
                    )},
                    {"type": "image_url", "image_url": {"url": f"data:{reference_mime};base64,{reference_b64}"}},
                    {"type": "image_url", "image_url": {"url": f"data:{candidate_mime};base64,{candidate_b64}"}},
                ],
            }],
            # gpt-6-astra is a reasoning model - see image_to_keyword's
            # comment. This specific check is the whole point of the
            # "product photo" search feature, so it gets the same generous
            # budget rather than risk a silent empty (default-False) match.
            max_completion_tokens=1000,
        )
        answer = resp.choices[0].message.content.strip().lower()
        # "unclear" is treated as a rejection, same as "no" - confirmed
        # live both ways: giving the model this third option (instead of
        # forcing a binary yes/no) correctly stops it from guessing "no"
        # on a genuinely blank/black loading-glitch thumbnail, but ALSO
        # gets used for ads whose visible-but-unrelated thumbnail frame
        # (an intro shot, a person, a scene with no product in view) isn't
        # the product-revealing moment of the video - and including those
        # as "matches" produced real false positives (verified: two
        # different competitor ads whose thumbnails showed people/scenes
        # with no product at all still passed when "unclear" counted as a
        # match). A missed match from a bad thumbnail is a smaller problem
        # than an irrelevant ad shown as if it were a real match - this
        # feature's whole point is trustworthy "yes" results.
        return answer.startswith("y")
    except Exception:
        return False


def filter_by_product_image(results, reference_image_bytes, reference_mime="image/jpeg", max_checked=30, max_workers=16):
    """Visually verifies which ads show the same product as the reference
    image. Only the first `max_checked` results (already sorted by
    days_running/variant_count) are checked, to bound API cost/latency -
    this is a real tradeoff: a matching ad ranked below that cutoff will be
    missed. Returns (matched, checked_count)."""
    reference_b64 = base64.b64encode(reference_image_bytes).decode()
    pool = results[:max_checked]
    matched_ids = set()
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {}
        for r in pool:
            if not r.get("thumbnail"):
                continue
            futures[ex.submit(_images_match, reference_b64, reference_mime, r["thumbnail"])] = r
        for fut in as_completed(futures):
            if fut.result():
                matched_ids.add(id(futures[fut]))
    matched = [r for r in pool if id(r) in matched_ids]
    return matched, len(pool)
