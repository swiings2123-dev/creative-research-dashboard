// Empty by default = same-origin (local Flask serving its own frontend).
// The Vercel-hosted static copy sets window.API_BASE before this script
// loads, to point at the worker's public URL instead (see web/index.html).
const API_BASE = window.API_BASE || "";
const API_SECRET = window.API_SECRET || "";
const authHeaders = API_SECRET ? { "X-App-Secret": API_SECRET } : {};

const form = document.getElementById("search-form");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const keywordInput = document.getElementById("keyword");
const countrySelect = document.getElementById("country");

let lastResults = [];
let lastKeyword = "";

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    keywordInput.value = chip.textContent;
    form.requestSubmit();
  });
});

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
  lastKeyword = keyword;
  showSkeletons(country === "WORLD", hasImageSignal);
  hideGenerateButton();

  const formData = new FormData();
  formData.append("keyword", keyword);
  formData.append("country", country);
  formData.append("product_url", productUrl);
  sources.forEach((s) => formData.append("sources", s));
  if (productImageInput.files[0]) formData.append("product_image", productImageInput.files[0]);

  const res = await fetch(API_BASE + "/search", { method: "POST", headers: authHeaders, body: formData });
  const data = await res.json();

  if (data.error) {
    statusEl.classList.remove("loading");
    let msg = "Error: " + data.error;
    if (data.notes && data.notes.length) msg += " (" + data.notes.join(" | ") + ")";
    statusEl.textContent = msg;
    resultsEl.innerHTML = "";
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
  resultsEl.innerHTML = "";
  data.results.forEach((ad, i) => resultsEl.appendChild(renderCard(ad, i)));

  if (data.results.length > 0) showGenerateButton();
});

function showSkeletons(isWorld, hasImageSignal) {
  statusEl.classList.add("loading");
  const parts = [];
  if (isWorld) parts.push("searching across the world");
  else parts.push("searching");
  if (hasImageSignal) parts.push("visually verifying the product match");
  statusEl.textContent = parts.join(", then ") + (isWorld || hasImageSignal ? " - this can take a few minutes..." : "...");
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

function renderCard(ad, index) {
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
  body.innerHTML = `
    <div class="platform">${ad.platform}${ad.country && ad.country !== "US" ? " · " + ad.country : ""}</div>
    <div class="advertiser">${escapeHtml(ad.advertiser || "Unknown")}</div>
    <div class="pill-row">${statusPill(ad.days_running)}${variantsPill}</div>
    <div class="body-text">${escapeHtml(ad.body || "")}</div>
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

  return card;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

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
