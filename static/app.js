// Empty by default = same-origin (local Flask serving its own frontend).
// The Vercel-hosted static copy sets window.API_BASE before this script
// loads, to point at the worker's public URL instead (see web/index.html).
const API_BASE = window.API_BASE || "";
const API_SECRET = window.API_SECRET || "";
const authHeaders = API_SECRET ? { "X-App-Secret": API_SECRET } : {};
// Set true only on the deployed copy (web/index.html) when the worker runs
// on a throttled free-tier host - a plain single-country search there can
// take several minutes (confirmed: 245s vs ~10-30s locally), not just
// World/picture mode. Without this flag, that would look exactly like the
// "it's not working" complaint this app already had once.
const SLOW_WORKER = window.SLOW_WORKER || false;

const form = document.getElementById("search-form");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const keywordInput = document.getElementById("keyword");
const countrySelect = document.getElementById("country");

let lastResults = [];
let lastKeyword = "";
// null for a plain keyword search, "india"/"international" after a
// Product Finder run - drives whether renderCard gets a "Mark as used"
// button (India finder only, per the user's explicit choice: a product
// keeps reappearing across finder runs until deliberately marked used).
let currentFinderMode = null;

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    keywordInput.value = chip.textContent;
    form.requestSubmit();
  });
});

// TikTok ads don't run in India at all - TikTok is banned there, so no
// advertiser can target Indian users (confirmed against the actual TikTok
// Apify actors' allowed-country lists - India isn't in either one). Shown
// whenever India is selected, regardless of the TikTok checkbox state, so
// it's informative before someone even decides to check that box.
const tiktokIndiaNotice = document.getElementById("tiktok-india-notice");
function updateTiktokIndiaNotice() {
  tiktokIndiaNotice.classList.toggle("hidden", countrySelect.value !== "IN");
}
countrySelect.addEventListener("change", updateTiktokIndiaNotice);
updateTiktokIndiaNotice();

const productImageInput = document.getElementById("product-image");
const productImageLabel = document.getElementById("product-image-label");
productImageInput.addEventListener("change", () => {
  const f = productImageInput.files[0];
  const label = document.querySelector(".file-input");
  if (f) {
    productImageLabel.textContent = "🖼️ " + f.name;
    label.classList.add("has-file");
  } else {
    productImageLabel.textContent = "🖼️ Product photo (optional) — matches this exact product";
    label.classList.remove("has-file");
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const keyword = keywordInput.value.trim();
  const country = countrySelect.value;
  const productUrl = document.getElementById("product-url").value.trim();
  const sources = [];
  if (document.getElementById("src-meta").checked) sources.push("meta");
  if (document.getElementById("src-tiktok").checked) sources.push("tiktok");

  if (!keyword && !productUrl && !productImageInput.files[0]) {
    statusEl.textContent = "Enter a keyword, a product link, or a product photo (at least one).";
    return;
  }

  const hasImageSignal = !!(productImageInput.files[0] || productUrl);
  const isWorld = country === "WORLD";
  const parts = [];
  if (isWorld) parts.push("searching across the world");
  else parts.push("searching");
  if (hasImageSignal) parts.push("visually verifying the product match");
  const slow = isWorld || hasImageSignal || SLOW_WORKER;
  let searchMsg = parts.join(", then ") + (slow ? " - this can take a few minutes..." : "...");
  if (SLOW_WORKER) searchMsg += " (running on free-tier hosting - even a plain search is slow here, this is expected)";

  lastKeyword = keyword;
  currentFinderMode = null;
  showSkeletons(searchMsg);
  hideGenerateButton();

  const formData = new FormData();
  formData.append("keyword", keyword);
  formData.append("country", country);
  formData.append("product_url", productUrl);
  sources.forEach((s) => formData.append("sources", s));
  if (productImageInput.files[0]) formData.append("product_image", productImageInput.files[0]);

  let data;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 240000);
    const res = await fetch(API_BASE + "/search", {
      method: "POST", headers: authHeaders, body: formData, signal: controller.signal,
    });
    clearTimeout(timeoutId);
    data = await res.json();
  } catch (err) {
    statusEl.classList.remove("loading");
    statusEl.textContent = err.name === "AbortError"
      ? "Timed out waiting for a response - the server may be overloaded, try again in a minute."
      : "Search failed: could not reach the server. Try again in a minute.";
    resultsEl.innerHTML = "";
    platformFilterEl.classList.add("hidden");
    return;
  }

  if (data.error) {
    statusEl.classList.remove("loading");
    let msg = "Error: " + data.error;
    if (data.notes && data.notes.length) msg += " (" + data.notes.join(" | ") + ")";
    statusEl.textContent = msg;
    resultsEl.innerHTML = "";
    platformFilterEl.classList.add("hidden");
    return;
  }

  lastKeyword = data.resolved_keyword || keyword;
  const errParts = Object.entries(data.errors || {}).map(([k, v]) => `${k}: ${v}`);
  const noteParts = data.notes || [];
  let statusText = `${data.results.length} ad(s) found`;
  if (data.resolved_keyword && data.resolved_keyword !== keyword) {
    statusText += ` for "${data.resolved_keyword}"`;
  }
  if (data.product_match_checked != null) {
    statusText += ` — visually matched against your product photo (checked top ${data.product_match_checked}).`;
  } else {
    statusText += ".";
  }
  if (errParts.length) statusText += " Issues - " + errParts.join(" | ");
  if (noteParts.length) statusText += " Notes - " + noteParts.join(" | ");

  statusEl.classList.remove("loading");
  statusEl.textContent = statusText;

  lastResults = data.results;
  renderPlatformFilter(data.results);
  renderResults(data.results);

  if (data.results.length > 0) showGenerateButton();
});

// Meta's public Ad Library has no scrapable per-ad signal for Facebook vs
// Instagram specifically (checked: platform icons are unlabeled CSS/sprite
// graphics, no alt text or data attributes) - "Meta" here always means
// both combined, that's the honest limit of what's extractable.
const PLATFORM_LABELS = {
  meta: "Meta (Facebook + Instagram)",
  tiktok: "TikTok",
};
const platformFilterEl = document.getElementById("platform-filter");
let activePlatformFilter = "all";

function renderPlatformFilter(results) {
  const counts = {};
  results.forEach((ad) => { counts[ad.platform] = (counts[ad.platform] || 0) + 1; });
  const platforms = Object.keys(counts);
  if (platforms.length < 2) {
    platformFilterEl.classList.add("hidden");
    platformFilterEl.innerHTML = "";
    activePlatformFilter = "all";
    return;
  }
  activePlatformFilter = "all";
  platformFilterEl.classList.remove("hidden");
  const tabs = [{ key: "all", label: `All (${results.length})` }].concat(
    platforms.map((p) => ({ key: p, label: `${PLATFORM_LABELS[p] || p} (${counts[p]})` }))
  );
  platformFilterEl.innerHTML = tabs
    .map((t) => `<button type="button" class="filter-tab${t.key === "all" ? " active" : ""}" data-platform="${t.key}">${t.label}</button>`)
    .join("");
  platformFilterEl.querySelectorAll(".filter-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      activePlatformFilter = btn.dataset.platform;
      platformFilterEl.querySelectorAll(".filter-tab").forEach((b) => b.classList.toggle("active", b === btn));
      const filtered = activePlatformFilter === "all"
        ? lastResults
        : lastResults.filter((ad) => ad.platform === activePlatformFilter);
      renderResults(filtered);
    });
  });
}

function cardOptsFor() {
  return currentFinderMode === "india" ? { onMarkUsed: markUsedHandler } : {};
}

function renderResults(results) {
  resultsEl.innerHTML = "";
  results.forEach((ad, i) => resultsEl.appendChild(renderCard(ad, i, cardOptsFor())));
}

function showSkeletons(message) {
  statusEl.classList.add("loading");
  platformFilterEl.classList.add("hidden");
  statusEl.textContent = message;
  resultsEl.innerHTML = "";
  for (let i = 0; i < 10; i++) {
    const s = document.createElement("div");
    s.className = "skeleton";
    s.innerHTML = '<div class="shimmer"></div>';
    resultsEl.appendChild(s);
  }
}

function statusPill(daysRunning) {
  if (daysRunning == null) return "";
  let cls = "new", label = `New · ${daysRunning}d`;
  if (daysRunning > 90) { cls = "proven"; label = `Proven · ${daysRunning}d running`; }
  else if (daysRunning >= 14) { cls = "scaling"; label = `Scaling · ${daysRunning}d running`; }
  return `<span class="pill ${cls}">${label}</span>`;
}

function renderCard(ad, index, opts = {}) {
  const card = document.createElement("div");
  card.className = "card";
  card.style.animationDelay = `${Math.min(index * 30, 400)}ms`;

  const video = document.createElement("video");
  video.src = ad.video_url;
  video.poster = ad.thumbnail || "";
  video.controls = true;
  // Not muted by default: playback only ever starts from an explicit user
  // click on the native controls (never autoplay), so browser autoplay-mute
  // policies don't apply here - no reason to force an extra unmute click.
  video.muted = false;
  video.loop = true;
  card.appendChild(video);

  const body = document.createElement("div");
  body.className = "card-body";
  const variantsPill = ad.variant_count > 1 ? `<span class="pill variants">×${ad.variant_count} variants</span>` : "";
  const evidenceLine = ad.evidence ? `<div class="evidence-line">${escapeHtml(ad.evidence)}</div>` : "";
  body.innerHTML = `
    <div class="platform platform-${ad.platform}">${(PLATFORM_LABELS[ad.platform] || ad.platform)}${ad.country && ad.country !== "US" ? " · " + ad.country : ""}</div>
    <div class="advertiser">${escapeHtml(ad.advertiser || "Unknown")}</div>
    <div class="pill-row">${statusPill(ad.days_running)}${variantsPill}</div>
    <div class="body-text">${escapeHtml(ad.body || "")}</div>
    ${evidenceLine}
  `;
  card.appendChild(body);

  // Click-to-open-permalink is scoped to the text area only, never the
  // video itself - a card-wide listener would risk swallowing clicks meant
  // for the native video controls (mute button included) if the browser's
  // shadow-DOM event retargeting ever reports a target other than the
  // video element for a click on those controls.
  if (ad.permalink) {
    body.style.cursor = "pointer";
    body.addEventListener("click", () => window.open(ad.permalink, "_blank"));
  }

  if (opts.onMarkUsed) {
    const markBtn = document.createElement("button");
    markBtn.type = "button";
    markBtn.className = "mark-used-btn";
    markBtn.textContent = "✅ Mark as used";
    markBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      markBtn.disabled = true;
      markBtn.textContent = "Marking...";
      opts.onMarkUsed(ad, card);
    });
    card.appendChild(markBtn);
  }

  return card;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Product Finder (India / International) ---
// Zero-keyword discovery: the backend runs a deep multi-minute Meta+TikTok
// sweep on a background thread (see finder.py) and returns a job_id right
// away - this polls for progress/results instead of one long request,
// since a deep run can take 20+ minutes, far past what a single HTTP
// request should stay open for.
const FINDER_MESSAGES = {
  india: "🇮🇳 Scanning TikTok Top Ads + 40 niches across India — this can take up to ~10 minutes...",
  international: "🌍 Screening 40 niches across 8 international markets, then checking India presence — this can take ~20-25 minutes...",
};
const finderIndiaBtn = document.getElementById("finder-india-btn");
const finderIntlBtn = document.getElementById("finder-intl-btn");
let finderPollTimer = null;
// A deep run takes 7-25 minutes - a reload during that window must not
// strand the user watching nothing, since the job keeps running server-
// side regardless. Best-effort only (a private window or cleared site
// data just means no auto-resume - the job itself is unaffected either
// way, it's not the source of truth).
const FINDER_JOB_STORAGE_KEY = "activeFinderJob";

function saveActiveFinderJob(jobId, mode) {
  try { localStorage.setItem(FINDER_JOB_STORAGE_KEY, JSON.stringify({ jobId, mode })); } catch (err) {}
}
function clearActiveFinderJob() {
  try { localStorage.removeItem(FINDER_JOB_STORAGE_KEY); } catch (err) {}
}
function loadActiveFinderJob() {
  try {
    const raw = localStorage.getItem(FINDER_JOB_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function setFinderButtonsDisabled(disabled) {
  finderIndiaBtn.disabled = disabled;
  finderIntlBtn.disabled = disabled;
}

async function startFinder(mode) {
  if (finderPollTimer) return; // a finder job is already being polled
  setFinderButtonsDisabled(true);
  currentFinderMode = mode;
  showSkeletons(FINDER_MESSAGES[mode]);
  hideGenerateButton();

  let res, data;
  try {
    res = await fetch(API_BASE + "/finder/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ mode }),
    });
    data = await res.json();
  } catch (err) {
    statusEl.classList.remove("loading");
    statusEl.textContent = "Could not reach the server. Try again in a minute.";
    setFinderButtonsDisabled(false);
    return;
  }

  if (res.status === 409 && data.job_id) {
    // A job is already running (e.g. from before a page reload) - resume
    // watching that one instead of just reporting "already running" and
    // leaving the user with no way to see it finish.
    currentFinderMode = data.mode;
    showSkeletons(FINDER_MESSAGES[data.mode] || "resuming an in-progress finder run...");
    pollFinderJob(data.job_id, data.mode);
    return;
  }

  if (!res.ok) {
    statusEl.classList.remove("loading");
    statusEl.textContent = "Error: " + (data.error || "could not start the finder");
    setFinderButtonsDisabled(false);
    return;
  }

  saveActiveFinderJob(data.job_id, mode);
  pollFinderJob(data.job_id, mode);
}

function pollFinderJob(jobId, mode) {
  setFinderButtonsDisabled(true);
  finderPollTimer = setInterval(async () => {
    let res, data;
    try {
      res = await fetch(API_BASE + `/finder/status/${jobId}`, { headers: authHeaders });
      data = await res.json();
    } catch (err) {
      return; // transient network hiccup - just try again next tick
    }

    if (!res.ok) {
      clearInterval(finderPollTimer);
      finderPollTimer = null;
      clearActiveFinderJob();
      setFinderButtonsDisabled(false);
      statusEl.classList.remove("loading");
      statusEl.textContent = "Error: " + (data.error || "finder job not found");
      return;
    }

    if (data.status === "running") {
      statusEl.textContent = data.progress || "working...";
      return;
    }

    clearInterval(finderPollTimer);
    finderPollTimer = null;
    clearActiveFinderJob();
    setFinderButtonsDisabled(false);
    statusEl.classList.remove("loading");

    if (data.status === "error") {
      statusEl.textContent = "Finder failed: " + (data.error || "unknown error");
      resultsEl.innerHTML = "";
      platformFilterEl.classList.add("hidden");
      return;
    }

    const results = data.results || [];
    const notes = data.notes || [];
    let statusText = `${results.length} product(s) found.`;
    if (notes.length) statusText += " Issues - " + notes.join(" | ");
    statusEl.textContent = statusText;
    lastResults = results;
    lastKeyword = mode === "india" ? "trending in India" : "international opportunity";
    renderPlatformFilter(results);
    renderResults(results);
    if (results.length > 0) showGenerateButton();
  }, 4000);
}

async function markUsedHandler(ad, card) {
  try {
    await fetch(API_BASE + "/finder/mark-used", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ platform: ad.platform, external_id: ad.library_id }),
    });
  } catch (err) {
    // best-effort - the card still comes out of view either way, and
    // a failed mark just means it can reappear on the next finder run.
  }
  card.remove();
}

finderIndiaBtn.addEventListener("click", () => startFinder("india"));
finderIntlBtn.addEventListener("click", () => startFinder("international"));

// Resume watching a finder job that was still running when the page was
// last reloaded/closed - the job itself runs server-side regardless, this
// just reconnects the UI to it instead of leaving the user with no way to
// see it finish short of guessing and hitting the 409-resume path above.
(function resumeActiveFinderJob() {
  const saved = loadActiveFinderJob();
  if (!saved) return;
  currentFinderMode = saved.mode;
  showSkeletons(FINDER_MESSAGES[saved.mode] || "resuming an in-progress finder run...");
  hideGenerateButton();
  pollFinderJob(saved.jobId, saved.mode);
})();

document.getElementById("lookup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const domain = document.getElementById("domain").value.trim();
  const out = document.getElementById("lookup-result");
  out.textContent = "Checking...";
  const res = await fetch(API_BASE + "/lookup-advertiser", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ domain }),
  });
  const data = await res.json();
  if (data.error) {
    out.textContent = "Error: " + data.error;
    return;
  }
  if (!data.advertisers || data.advertisers.length === 0) {
    out.textContent = "No Google Ads Transparency data found for that domain.";
    return;
  }
  out.innerHTML = `Advertiser accounts found: ${data.advertisers.join(", ")}. <a href="${data.link}" target="_blank">View on Google Ads Transparency Center</a>`;
});

// --- AI creative angle generator ---
let generateBtn = null;
const anglesPanel = document.getElementById("angles-panel");
const anglesContent = document.getElementById("angles-content");
document.getElementById("angles-close").addEventListener("click", () => anglesPanel.classList.add("hidden"));

function showGenerateButton() {
  if (!generateBtn) {
    generateBtn = document.createElement("button");
    generateBtn.className = "generate-btn";
    generateBtn.textContent = "✨ Generate AI angles";
    generateBtn.addEventListener("click", runGenerateAngles);
    document.body.appendChild(generateBtn);
  }
  generateBtn.classList.remove("hidden");
}
function hideGenerateButton() {
  if (generateBtn) generateBtn.classList.add("hidden");
}

async function runGenerateAngles() {
  anglesPanel.classList.remove("hidden");
  anglesContent.textContent = "Thinking...";
  const ad_bodies = lastResults.map((r) => r.body).filter(Boolean);
  const res = await fetch(API_BASE + "/generate-angles", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ keyword: lastKeyword, ad_bodies }),
  });
  const data = await res.json();
  anglesContent.textContent = data.angles || ("Error: " + data.error);
}
