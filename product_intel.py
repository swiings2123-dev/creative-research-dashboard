"""
Turns a product link and/or product photo into a clean ad-library search
query, and (when a reference product image is available) visually verifies
that a candidate ad thumbnail actually shows the same product.

Product pages are read with a plain HTTP GET, not a browser - og:title/
og:image meta tags are meant for social-media crawlers, so they're almost
always present in the raw server-rendered HTML even on JS-heavy storefronts
(Shopify etc.), no Playwright needed here.
"""

import os
import base64
from html.parser import HTMLParser
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from openai import OpenAI

_client = None


def _get_client():
    global _client
    if _client is None:
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY not set - add it to .env")
        _client = OpenAI(api_key=api_key)
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


def fetch_product_page(url, timeout=15):
    resp = requests.get(url, timeout=timeout, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    parser = _OGParser()
    parser.feed(resp.text[:400000])
    return {
        "title": parser.tags.get("og:title") or parser.tags.get("twitter:title") or parser.title,
        "description": parser.tags.get("og:description"),
        "image_url": parser.tags.get("og:image") or parser.tags.get("twitter:image"),
    }


def image_to_keyword(image_bytes, mime="image/jpeg"):
    b64 = base64.b64encode(image_bytes).decode()
    resp = _get_client().chat.completions.create(
        model=os.environ.get("OPENAI_VISION_MODEL", "gpt-4o-mini"),
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
        max_tokens=20,
        temperature=0.2,
    )
    return resp.choices[0].message.content.strip()


def synthesize_query(keyword=None, product_title=None, image_keyword=None):
    parts = [p for p in [keyword, image_keyword, product_title] if p]
    if len(parts) <= 1:
        return parts[0] if parts else None
    resp = _get_client().chat.completions.create(
        model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
        messages=[{
            "role": "user",
            "content": (
                "These all describe the same product, from different sources: "
                + " | ".join(parts)
                + ". Reply with ONLY one concise 2-5 word search query that best "
                "captures the product category, suitable for searching an ad library."
            ),
        }],
        max_tokens=20,
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
            model=os.environ.get("OPENAI_VISION_MODEL", "gpt-4o-mini"),
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": (
                        "Do these two images show the same physical product "
                        "(same design/category), even if angle, color, or "
                        "background differ? Reply with ONLY 'yes' or 'no'."
                    )},
                    {"type": "image_url", "image_url": {"url": f"data:{reference_mime};base64,{reference_b64}"}},
                    {"type": "image_url", "image_url": {"url": f"data:{candidate_mime};base64,{candidate_b64}"}},
                ],
            }],
            max_tokens=5,
            temperature=0,
        )
        return resp.choices[0].message.content.strip().lower().startswith("y")
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
