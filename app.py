import json
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from flask import Flask, render_template, request, jsonify, abort

import db
import finder
import meta_scrape
import tiktok_scrape
import google_lookup


def _load_dotenv():
    path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


_load_dotenv()

app = Flask(__name__)
db.init_db()


# CORS + a lightweight shared-secret gate: this worker is meant to be called
# from a frontend hosted on a different origin (Vercel) once deployed. If
# APP_SHARED_SECRET is set, costly routes (scraping, OpenAI calls) require a
# matching X-App-Secret header. This is NOT real auth - a client-embedded
# secret is visible to anyone who views the deployed frontend's source - it
# only raises the bar above "wide open," stopping casual/automated abuse of
# your OpenAI key and scraping capacity. Unset locally, so local dev is
# unaffected.
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")


@app.after_request
def _add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-App-Secret"
    return resp


@app.route("/search", methods=["OPTIONS"])
@app.route("/lookup-advertiser", methods=["OPTIONS"])
@app.route("/generate-angles", methods=["OPTIONS"])
@app.route("/finder/start", methods=["OPTIONS"])
@app.route("/finder/status/<job_id>", methods=["OPTIONS"])
@app.route("/finder/mark-used", methods=["OPTIONS"])
def _cors_preflight(job_id=None):
    return "", 204


def _require_secret():
    expected = os.environ.get("APP_SHARED_SECRET")
    if expected and request.headers.get("X-App-Secret") != expected:
        abort(401, description="missing or invalid X-App-Secret header")


def _cached_search(source, fn, keyword, country, *args):
    cached = db.get_cached(source, keyword, country)
    if cached is not None:
        return cached, None
    try:
        results = fn(keyword, *args)
        db.set_cached(source, keyword, country, results)
        return results, None
    except Exception as e:
        return [], str(e)


def _resolve_query_and_image(keyword, product_url, image_file):
    """Combines whichever of {keyword, product link, product image} were
    given into one search query, plus a reference product image (uploaded
    image takes priority; falls back to the product link's og:image) for
    later visual verification. Returns (resolved_keyword, image_bytes,
    image_mime, notes)."""
    import product_intel

    notes = []
    image_bytes = None
    image_mime = "image/jpeg"
    if image_file and image_file.filename:
        image_bytes = image_file.read()
        image_mime = image_file.content_type or image_mime
    url_title = None

    if product_url:
        try:
            page = product_intel.fetch_product_page(product_url)
            url_title = page.get("title")
            if not image_bytes and page.get("image_url"):
                r = requests.get(page["image_url"], timeout=10, headers={"User-Agent": "Mozilla/5.0"})
                r.raise_for_status()
                image_bytes = r.content
                image_mime = product_intel._guess_mime(r.headers.get("Content-Type"))
        except Exception as e:
            notes.append(f"product link: {e}")

    image_keyword = None
    if image_bytes:
        try:
            image_keyword = product_intel.image_to_keyword(image_bytes, mime=image_mime)
        except Exception as e:
            notes.append(f"image analysis: {e}")

    resolved = keyword
    if image_keyword or url_title:
        try:
            synthesized = product_intel.synthesize_query(
                keyword=keyword or None, product_title=url_title, image_keyword=image_keyword
            )
            resolved = synthesized or resolved
        except Exception as e:
            notes.append(f"query synthesis: {e}")
            resolved = resolved or image_keyword or url_title

    return resolved, image_bytes, image_mime, notes


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/search", methods=["POST"])
def search():
    _require_secret()
    keyword = (request.form.get("keyword") or "").strip()
    country = request.form.get("country") or "US"
    sources = request.form.getlist("sources")
    product_url = (request.form.get("product_url") or "").strip()
    image_file = request.files.get("product_image")

    if not keyword and not product_url and not (image_file and image_file.filename):
        return jsonify({"error": "provide a keyword, product link, or product image"}), 400
    if not sources:
        return jsonify({"error": "select at least one source (Meta or TikTok)"}), 400

    resolved_keyword, image_bytes, image_mime, notes = _resolve_query_and_image(keyword, product_url, image_file)
    if not resolved_keyword:
        return jsonify({
            "error": "could not determine a search term from the inputs given",
            "notes": notes,
        }), 400

    # Meta and TikTok are both independent Apify actor calls now (plain
    # HTTP, no local Chromium for either) - running them in parallel
    # threads instead of one-after-another roughly halves wall time when
    # both sources are selected, at no extra cost.
    jobs = {}
    if "meta" in sources:
        if country == "WORLD":
            jobs["meta"] = (meta_scrape.search_world, "WORLD")
        else:
            jobs["meta"] = (meta_scrape.search, country, country)
    if "tiktok" in sources:
        # Apify's actor wants a real ISO code or "all" - "WORLD" is this
        # app's own UI-level concept, not something the actor understands.
        # Passed twice, mirroring the Meta tuple's (fn, country, country)
        # shape, so _cached_search's own `country` param (used for the
        # cache key) and the value actually forwarded to `fn` agree - they
        # used to disagree, silently dropping country from the real call
        # entirely while still caching per-country (wasted Apify spend on
        # cache misses that all returned identical underlying data).
        tiktok_country = "all" if country == "WORLD" else country
        jobs["tiktok"] = (tiktok_scrape.search, tiktok_country, tiktok_country)

    results = []
    errors = {}
    with ThreadPoolExecutor(max_workers=max(1, len(jobs))) as ex:
        futures = {
            ex.submit(_cached_search, source, spec[0], resolved_keyword, *spec[1:]): source
            for source, spec in jobs.items()
        }
        for fut in as_completed(futures):
            source = futures[fut]
            r, err = fut.result()
            results.extend(r)
            if err:
                errors[source] = err

    results.sort(key=lambda r: ((r.get("days_running") or 0), r.get("variant_count") or 1), reverse=True)

    product_match_checked = None
    if image_bytes and results:
        import product_intel
        try:
            matched, checked = product_intel.filter_by_product_image(results, image_bytes, image_mime)
            product_match_checked = checked
            results = matched
        except Exception as e:
            notes.append(f"product image matching: {e}")

    return jsonify({
        "results": results,
        "errors": errors,
        "resolved_keyword": resolved_keyword,
        "product_match_checked": product_match_checked,
        "notes": notes,
    })


@app.route("/finder/start", methods=["POST"])
def finder_start():
    _require_secret()
    data = request.get_json(force=True)
    mode = (data.get("mode") or "").strip()
    if mode not in ("india", "international"):
        return jsonify({"error": "mode must be 'india' or 'international'"}), 400

    running = db.get_running_job()
    if running:
        if finder.is_stale(running):
            db.fail_job(running["job_id"], "no progress for 10+ minutes - the background job likely died (e.g. the server restarted mid-run); start a new run")
        else:
            return jsonify({"error": "a finder job is already running", "job_id": running["job_id"], "mode": running["mode"]}), 409

    job_id = uuid.uuid4().hex
    db.create_job(job_id, mode)
    target = finder.run_india_finder if mode == "india" else finder.run_international_finder
    threading.Thread(target=target, args=(job_id,), daemon=True).start()
    return jsonify({"job_id": job_id, "mode": mode}), 202


@app.route("/finder/status/<job_id>", methods=["GET"])
def finder_status(job_id):
    _require_secret()
    row = db.get_job(job_id)
    if row is None:
        return jsonify({"error": "job not found"}), 404

    if finder.is_stale(row):
        db.fail_job(job_id, "no progress for 10+ minutes - the background job likely died (e.g. the server restarted mid-run); start a new run")
        row = db.get_job(job_id)

    payload = json.loads(row["results_json"]) if row["results_json"] else {}
    return jsonify({
        "job_id": row["job_id"],
        "mode": row["mode"],
        "status": row["status"],
        "progress": row["progress"],
        "results": payload.get("results"),
        "notes": payload.get("notes") or [],
        "error": row["error"],
    })


@app.route("/finder/mark-used", methods=["POST"])
def finder_mark_used():
    _require_secret()
    data = request.get_json(force=True)
    platform = (data.get("platform") or "").strip()
    external_id = (data.get("external_id") or "").strip()
    if not platform or not external_id:
        return jsonify({"error": "platform and external_id required"}), 400
    db.mark_used(platform, external_id)
    return jsonify({"ok": True})


@app.route("/lookup-advertiser", methods=["POST"])
def lookup_advertiser():
    _require_secret()
    data = request.get_json(force=True)
    domain = (data.get("domain") or "").strip()
    if not domain:
        return jsonify({"error": "domain required"}), 400
    try:
        return jsonify(google_lookup.lookup(domain))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/generate-angles", methods=["POST"])
def generate_angles():
    _require_secret()
    import openai_angles

    data = request.get_json(force=True)
    keyword = (data.get("keyword") or "").strip()
    ad_bodies = data.get("ad_bodies") or []
    if not keyword or not ad_bodies:
        return jsonify({"error": "keyword and ad_bodies required"}), 400
    try:
        text = openai_angles.generate_angles(keyword, ad_bodies[:15])
        return jsonify({"angles": text})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=True, port=5000)
