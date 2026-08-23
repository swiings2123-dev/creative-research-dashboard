# Setup

```
pip install -r requirements.txt
python -m playwright install chromium
python app.py
```

Open http://localhost:5000.

Search works with any combination of: a keyword, a product link, a product
photo. At least one is required; more signals = more accurate results (a
product link/photo gets visually matched against every candidate ad, not
just keyword-filtered).

## AI features (angles + product link/photo search)

Copy `.env.example` to `.env` and put your OpenAI key in as
`OPENAI_API_KEY=...`. Without it, keyword-only search still works fully;
you'll just get a clear error if you click "Generate AI angles" or submit
a product link/photo with no key set.

## What's verified vs. not

- **Meta (Facebook/Instagram)**: tested live, works. Real running ads with
  video, advertiser, copy, days running, and "×N variants" (scale signal).
- **Google Ads Transparency lookup**: tested live, works. Domain-only, not
  keyword search — use it after you've already found a competitor via Meta.
- **TikTok Creative Center**: NOT tested — TikTok's domain was unreachable
  from the network this was built on. Fails silently (shown as an "Issues"
  note) without breaking Meta results if it doesn't work on your machine.
- **Product link → search**: tested live against a real Shopify product
  page (reads og:title/og:description/og:image — works on essentially any
  storefront, since those tags are meant for social crawlers, not just
  Meta's own).
- **Product photo → search + visual match**: tested live. Works, but two
  real tradeoffs to know about:
  - It's strict by design (same physical product, not just same category)
    since you asked for "no other ad" — so if you want broader results,
    search by keyword alone instead of adding a photo.
  - Facebook's video "poster" thumbnail is occasionally a blurry
    loading-glitch frame rather than a real product frame — when that
    happens, a genuinely matching ad can get filtered out. Not a logic
    bug, just a data-quality limit of the free thumbnail source.
  - Only the top 30 candidates (by days-running/scale, already
    best-first) get visually checked, to keep this to a couple of
    minutes instead of five-plus. Tunable in `product_intel.py`
    (`filter_by_product_image`'s `max_checked`).

## If a scraper breaks

Facebook/TikTok/Google can change their page markup at any time — there's
no contract that these keep working. If Meta results suddenly stop
parsing, the fix is almost always in `meta_scrape.py`'s `_parse_card`
regexes (search for "Library ID" / "Started running on" text changes).
