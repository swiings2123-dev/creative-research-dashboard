"""
Plain-assert checks for the Product Finder's non-obvious logic (no test
framework, matching this repo's existing zero-dependency baseline). Run
directly: python test_finder.py
"""

import time

import finder
import tiktok_scrape


def test_top_ads_rejects_india():
    # Confirmed live against the actor: India isn't a valid country for
    # TikTok's Top Ads dashboard at all (TikTok ads don't run there) -
    # this must fail fast, locally, not surface as a confusing Apify 400
    # from inside a 20-minute finder run.
    try:
        tiktok_scrape.search_top_ads(country="IN")
        assert False, "expected ValueError for country=IN"
    except ValueError:
        pass


def test_main_actor_country_fallback_set():
    # search()'s EU-transparency actor - India, US, and most of this app's
    # own country dropdown aren't valid values for it either.
    assert "IN" not in tiktok_scrape.MAIN_ACTOR_COUNTRIES
    assert "US" not in tiktok_scrape.MAIN_ACTOR_COUNTRIES
    assert "GB" in tiktok_scrape.MAIN_ACTOR_COUNTRIES


def test_intl_markets_are_valid_top_ads_countries():
    # Every finder.INTL_MARKETS entry must actually be usable by
    # tiktok_scrape.search_top_ads, or the International finder's TikTok
    # leg silently drops that market on every run.
    for market in finder.INTL_MARKETS:
        assert market in tiktok_scrape.TOP_ADS_COUNTRIES, market


def test_is_stale():
    now = time.time()
    fresh = {"status": "running", "updated_at": now - 599}
    dead = {"status": "running", "updated_at": now - 601}
    done = {"status": "done", "updated_at": now - 10_000}
    assert finder.is_stale(fresh) is False
    assert finder.is_stale(dead) is True
    assert finder.is_stale(done) is False  # not "running" - staleness doesn't apply


def test_dedupe_by_library_id():
    ads = [
        {"library_id": "1", "platform": "meta"},
        {"library_id": "2", "platform": "meta"},
        {"library_id": "1", "platform": "meta"},  # duplicate
        {"library_id": None, "platform": "tiktok"},  # missing id, dropped
    ]
    deduped = finder._dedupe_by_library_id(ads)
    assert [a["library_id"] for a in deduped] == ["1", "2"]


if __name__ == "__main__":
    test_top_ads_rejects_india()
    test_main_actor_country_fallback_set()
    test_intl_markets_are_valid_top_ads_countries()
    test_is_stale()
    test_dedupe_by_library_id()
    print("all finder tests passed")
