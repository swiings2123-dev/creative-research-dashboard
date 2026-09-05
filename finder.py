"""
Product Finder: two zero-keyword discovery modes on top of the manual
search in app.py's /search route.

- India finder: what's trending in India right now, excluding anything the
  user has already marked used via /finder/mark-used. Meta-only - TikTok
  ads simply don't run in India (confirmed live: "IN" isn't in either
  Apify actor's allowed country values, see tiktok_scrape.py's module
  docstring), so there's no TikTok signal to add here.
- International finder: what's viral in major international markets but
  has little-to-no presence in India yet (an untapped-in-India
  opportunity). Meta leg does a real per-keyword India-vs-international ad
  count comparison; the TikTok leg pulls each market's Top Ads directly -
  every result is structurally guaranteed to have zero India presence
  already (same reason as above), so no separate India check is needed
  for TikTok candidates.

Both guarantee at least MIN_RESULTS items (no ceiling otherwise) by
backfilling from a second keyword/market pool when the primary pass comes
up short - the same "boost-fill" idea app.py's /search already uses for
Meta (MIN_TARGET_RESULTS/BOOST_COUNTRIES), applied here to niches/markets
instead of countries. This matters most for the India finder once you've
been marking products used for a while - the unused pool naturally
shrinks, so a fixed 40-keyword sweep alone can eventually fall short.

Both run as background threads (see app.py's /finder/start) since a deep
run takes minutes, not seconds - see db.py's finder_jobs table for how
progress/results get back to the polling frontend.
"""

import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import db
import meta_scrape
import tiktok_scrape

# Dropshipping niche terms swept automatically for the Meta leg of both
# finders (Meta's Ad Library has no keyword-less browse mode for ordinary
# commercial ads - confirmed via research - so discovery has to be driven
# by search terms, not a free feed). Deliberately overlaps a few terms with
# templates/index.html's "Try:" chips (posture corrector, led strip
# lights, portable blender, pet grooming glove, resistance bands) - those
# are already confirmed-good query terms, no reason to avoid the overlap.
SEED_KEYWORDS = [
    # posture / wellness
    "posture corrector", "neck massager", "back massager", "foot massager",
    # beauty tools
    "facial massage roller", "blackhead remover", "hair straightening brush",
    "nail art stamping kit", "cordless hair trimmer",
    # pet grooming
    "pet grooming glove", "pet hair remover roller", "dog nail grinder",
    # car accessories
    "car vacuum cleaner", "car phone mount", "car seat gap organizer", "car trunk organizer",
    # kitchen gadgets
    "kitchen gadget organizer", "portable blender", "electric knife sharpener",
    "multi-function vegetable chopper",
    # fitness gadgets
    "resistance bands", "ab roller wheel", "jump rope", "fitness resistance loop bands",
    # home organizers
    "desk cable organizer", "closet organizer bins",
    # phone / tech accessories
    "phone camera lens kit", "selfie ring light", "wireless earbuds",
    # baby products
    "baby monitor camera", "baby food maker", "diaper bag backpack",
    # LED / lighting
    "led strip lights", "motion sensor led light", "solar garden lights",
    # cleaning gadgets
    "mini handheld vacuum", "window cleaning robot",
    # outdoor / camping
    "camping lantern", "portable camping stove",
    # jewelry organizers
    "jewelry organizer box",
]

# Second-tier niche pool, only swept when the primary SEED_KEYWORDS pass
# doesn't clear MIN_RESULTS (see _backfill_keywords below) - kept as a
# disjoint list rather than just "more of the same" so a floor-topping
# pass actually surfaces different products, not near-duplicates of what
# the primary pass already found.
BACKUP_SEED_KEYWORDS = [
    "electric spin scrubber", "cordless vacuum mop", "smart water bottle",
    "posture bra", "knee brace support", "back stretcher device",
    "acupressure mat", "hair growth serum applicator", "teeth whitening kit",
    "nose hair trimmer", "electric can opener", "egg cooker",
    "air fryer liner", "silicone baking mat", "magnetic phone mount",
    "car seat organizer kids", "dog car seat cover", "cat scratching post",
    "bird feeder camera", "plant grow light", "humidifier diffuser",
    "posture pillow", "compression socks", "waist trainer",
    "yoga wheel", "massage gun",
]

# Reuses 4 of app.py's already-battle-tested BOOST_COUNTRIES (GB, CA, AU,
# DE) + US as the anchor market, plus FR/BR/SA for non-Anglophone/non-EU
# diversity. Drops CN (Meta is blocked in mainland China, per
# meta_scrape.py's own WORLD_COUNTRIES comment - pure wasted scroll time
# here). All 8 are also confirmed-valid TOP_ADS_COUNTRIES values for the
# TikTok leg (tiktok_scrape.search_top_ads) - checked against the actor's
# real allow-list, not assumed.
INTL_MARKETS = ["US", "GB", "CA", "AU", "DE", "FR", "BR", "SA"]

# Second-tier markets for the International finder's floor-topping pass -
# also confirmed-valid TOP_ADS_COUNTRIES values, disjoint from INTL_MARKETS.
BACKUP_INTL_MARKETS = ["PH", "ID", "MX", "AE", "NL", "JP", "TH", "KR"]

# Meta and TikTok are both plain Apify HTTP calls now, not local Chromium
# instances - no more OOM ceiling to respect, so this can run well above
# the old 2-instance Playwright-era cap.
FINDER_CONCURRENCY = 6
TIKTOK_QUERY_CONCURRENCY = 4    # Apify HTTP calls - io-bound, no Chromium involved

MIN_RESULTS = 20                 # hard floor for both finders - no ceiling otherwise
INTL_MIN_ADS = 15               # Phase-1 screen: permissive on purpose - a false
                                 # positive costs one extra India-check call, a
                                 # false negative kills a real opportunity forever.
INDIA_MAX_ADS = 3               # "essentially untested in India" - not strictly 0,
                                 # a couple of copycat sellers doesn't mean saturated.
TIKTOK_TOP_ADS_PER_MARKET = 15  # per market, how many Top Ads to pull
INTL_ADS_PER_KEYWORD = 3        # how many actual ad creatives to surface per
                                 # qualifying international Meta keyword

# Meta search is now a paid Apify actor call, not a free Playwright
# scrape - these keep each finder's Meta cost bounded and deliberately
# match each phase's actual precision need rather than always asking for
# max depth: the India sweep is the real discovery source so it gets a
# generous limit, while phase 1/2 only need enough depth to clear/reject
# a threshold (15 and 3 respectively), not to enumerate every ad.
INDIA_SWEEP_RESULTS_LIMIT = 50
PHASE1_RESULTS_LIMIT = 15
PHASE2_RESULTS_LIMIT = 15

STALE_JOB_TIMEOUT_S = 600       # no progress update in 10 min -> treat as dead
                                 # (the background thread died with a worker recycle)


def is_stale(job_row):
    return job_row["status"] == "running" and (time.time() - job_row["updated_at"]) > STALE_JOB_TIMEOUT_S


def _dedupe_by_library_id(ads):
    seen = set()
    out = []
    for a in ads:
        lid = a.get("library_id")
        if lid and lid not in seen:
            seen.add(lid)
            out.append(a)
    return out


# --- India finder (Meta-only, see module docstring) ---------------------

def _india_meta_sweep(job_id, keywords, notes, label="Meta"):
    ads = []
    with ThreadPoolExecutor(max_workers=FINDER_CONCURRENCY) as ex:
        futures = {ex.submit(meta_scrape.search, kw, "IN", INDIA_SWEEP_RESULTS_LIMIT): kw for kw in keywords}
        done = 0
        for fut in as_completed(futures):
            done += 1
            kw = futures[fut]
            db.update_job_progress(job_id, f"{label}: scanned {done}/{len(keywords)} niches in India ({kw})")
            try:
                ads.extend(fut.result())
            except Exception as e:
                notes.append(f"Meta search failed for '{kw}': {e}")
    return ads


def run_india_finder(job_id):
    try:
        db.update_job_progress(job_id, "starting India finder...")
        used_meta = db.get_used_ids("meta")
        notes = []

        ads = _india_meta_sweep(job_id, SEED_KEYWORDS, notes)
        ads = _dedupe_by_library_id(ads)
        results = [a for a in ads if a.get("library_id") not in used_meta]

        if len(results) < MIN_RESULTS:
            db.update_job_progress(job_id, f"only {len(results)}/{MIN_RESULTS} unused results so far - topping up from backup niches...")
            backup_ads = _india_meta_sweep(job_id, BACKUP_SEED_KEYWORDS, notes, label="Meta backfill")
            ads = _dedupe_by_library_id(ads + backup_ads)
            results = [a for a in ads if a.get("library_id") not in used_meta]

        results.sort(key=lambda r: ((r.get("days_running") or 0), r.get("variant_count") or 1), reverse=True)

        if not results and notes:
            notes.insert(0, "No results because every Meta search failed - see notes below.")
        db.finish_job(job_id, results, notes)
    except Exception as e:
        db.fail_job(job_id, str(e))


# --- International finder ----------------------------------------------

def _intl_meta_phase1(job_id, notes, keywords, label="Meta"):
    """Shallow multi-country pass per niche - screens for niches with real
    international scale before paying for a deep per-niche India check."""
    qualifying = []  # list of (keyword, intl_ads)
    with ThreadPoolExecutor(max_workers=FINDER_CONCURRENCY) as ex:
        futures = {
            ex.submit(meta_scrape.search_world, kw, INTL_MARKETS, PHASE1_RESULTS_LIMIT): kw
            for kw in keywords
        }
        done = 0
        for fut in as_completed(futures):
            done += 1
            kw = futures[fut]
            db.update_job_progress(
                job_id, f"{label}: screened {done}/{len(keywords)} niches internationally ({kw})"
            )
            try:
                intl_ads = fut.result()
            except Exception as e:
                notes.append(f"Meta international screen failed for '{kw}': {e}")
                continue
            if len(intl_ads) >= INTL_MIN_ADS:
                qualifying.append((kw, intl_ads))
    return qualifying


def _intl_meta_phase2(job_id, qualifying, notes, label="Meta"):
    """Full-depth India check, only for niches that cleared phase 1."""
    candidates = []
    with ThreadPoolExecutor(max_workers=FINDER_CONCURRENCY) as ex:
        futures = {
            ex.submit(meta_scrape.search, kw, "IN", PHASE2_RESULTS_LIMIT): (kw, intl_ads)
            for kw, intl_ads in qualifying
        }
        done = 0
        for fut in as_completed(futures):
            done += 1
            kw, intl_ads = futures[fut]
            db.update_job_progress(
                job_id, f"{label}: India-checked {done}/{len(qualifying)} candidate niches ({kw})"
            )
            try:
                india_ads = fut.result()
            except Exception as e:
                notes.append(f"Meta India check failed for '{kw}': {e}")
                continue
            if len(india_ads) <= INDIA_MAX_ADS:
                countries = sorted({a["country"] for a in intl_ads if a.get("country")})
                evidence = (
                    f"🌍 {len(intl_ads)} intl ads across {', '.join(countries[:4])} "
                    f"· 🇮🇳 {len(india_ads)} ad(s) in India"
                )
                top_ads = sorted(
                    intl_ads,
                    key=lambda r: ((r.get("days_running") or 0), r.get("variant_count") or 1),
                    reverse=True,
                )[:INTL_ADS_PER_KEYWORD]
                for ad in top_ads:
                    ad = dict(ad)
                    ad["evidence"] = evidence
                    candidates.append(ad)
    return candidates


def _intl_tiktok_phase(job_id, notes, markets, label="TikTok"):
    """Pulls each market's Top Ads directly - no keyword sweep needed, and
    no India cross-check needed either, since TikTok ads structurally
    never run in India (see tiktok_scrape.py)."""
    candidates = []
    with ThreadPoolExecutor(max_workers=TIKTOK_QUERY_CONCURRENCY) as ex:
        futures = {
            ex.submit(tiktok_scrape.search_top_ads, market, 7, "like", TIKTOK_TOP_ADS_PER_MARKET): market
            for market in markets
        }
        done = 0
        for fut in as_completed(futures):
            done += 1
            market = futures[fut]
            db.update_job_progress(job_id, f"{label}: pulled Top Ads for {done}/{len(markets)} markets ({market})")
            try:
                candidates.extend(fut.result())
            except Exception as e:
                # notes.append is a plain list mutation from a second real
                # thread (this phase runs inside run_international_finder's
                # own ThreadPoolExecutor, concurrently with the Meta phases
                # on the main thread) - safe without a lock: CPython's GIL
                # makes a single list.append atomic.
                notes.append(f"TikTok Top Ads failed for market '{market}': {e}")
                continue
    return candidates


def run_international_finder(job_id):
    try:
        db.update_job_progress(job_id, "starting International finder (Phase 1: screening niches)...")
        notes = []

        with ThreadPoolExecutor(max_workers=2) as top_ex:
            tiktok_future = top_ex.submit(_intl_tiktok_phase, job_id, notes, INTL_MARKETS)
            qualifying = _intl_meta_phase1(job_id, notes, SEED_KEYWORDS)

            db.update_job_progress(
                job_id, f"Meta: {len(qualifying)} niches cleared the international bar, checking India presence..."
            )
            meta_candidates = _intl_meta_phase2(job_id, qualifying, notes)
            tiktok_candidates = tiktok_future.result()

        results = meta_candidates + _dedupe_by_library_id(tiktok_candidates)

        if len(results) < MIN_RESULTS:
            db.update_job_progress(job_id, f"only {len(results)}/{MIN_RESULTS} results so far - topping up from backup niches/markets...")
            with ThreadPoolExecutor(max_workers=2) as top_ex:
                backup_tiktok_future = top_ex.submit(_intl_tiktok_phase, job_id, notes, BACKUP_INTL_MARKETS, "TikTok backfill")
                backup_qualifying = _intl_meta_phase1(job_id, notes, BACKUP_SEED_KEYWORDS, "Meta backfill")
                backup_meta_candidates = _intl_meta_phase2(job_id, backup_qualifying, notes, "Meta backfill")
                backup_tiktok_candidates = backup_tiktok_future.result()
            results += backup_meta_candidates
            results += _dedupe_by_library_id(backup_tiktok_candidates)

        results.sort(key=lambda a: a.get("likes") if a.get("likes") is not None else (a.get("days_running") or 0), reverse=True)

        if not results and notes:
            notes.insert(0, "No results because every Meta and/or TikTok call failed - see notes below.")
        db.finish_job(job_id, results, notes)
    except Exception as e:
        db.fail_job(job_id, str(e))
