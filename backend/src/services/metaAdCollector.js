const { ApifyClient } = require('apify-client');
const config = require('../config');
const logger = require('../utils/logger');
const { brandedProduct } = require('../utils/queryText');
const { hashVideoUrl } = require('../db/queries');

let client = null;
if (config.apifyToken && config.apifyToken !== 'your_apify_api_token_here') {
  client = new ApifyClient({ token: config.apifyToken });
}

const MAX_QUERIES_PER_RUN = 4;
const RESULTS_PER_QUERY = 15;
// Deep pass when earlier searches already returned most of the first page
const DEEP_RESULTS_PER_QUERY = 40;

/**
 * Collect Meta Ad Library video ads using Apify's Facebook Ads scraper.
 * Each keyword becomes an Ad Library search URL filtered to video creatives,
 * then broadens to category-level keywords if fewer than minResults were found.
 */
async function collectMetaAds(productAnalysis, existingHashes = new Set(), minResults = 20) {
  logger.info('Meta Ad collector: starting', {
    keywords: productAnalysis.metaAdKeywords?.length,
    hasToken: Boolean(client),
  });

  const allVideos = [];
  const seenUrls = new Set();

  if (!client) {
    logger.warn('Meta Ad collector: Apify token not configured, no ads collected');
    return allVideos;
  }

  // Only videos the user has not seen in earlier searches count toward the minimum
  const freshCount = () => allVideos.filter((v) => !existingHashes.has(hashVideoUrl(v.videoUrl))).length;

  const runQueries = async (queries, exactPhrase, perQuery = RESULTS_PER_QUERY) => {
    if (queries.length === 0) return;

    try {
      logger.info('Meta Ad collector: querying Apify actor', { queries });

      const run = await client.actor('apify/facebook-ads-scraper').call(
        {
          startUrls: queries.map((q) => ({ url: buildAdLibraryUrl(q, exactPhrase) })),
          resultsLimit: perQuery,
        },
        {
          timeout: config.apifyTimeoutSecs,
          memory: 512,
          log: null,
        }
      );

      const { items } = await client.dataset(run.defaultDatasetId).listItems();

      for (const item of items) {
        const adArchiveId = item.adArchiveID || item.adArchiveId;
        if (!adArchiveId) continue;

        const videoUrl = `https://www.facebook.com/ads/library/?id=${adArchiveId}`;
        if (seenUrls.has(videoUrl)) continue;

        if (!hasVideoCreative(item)) continue;
        seenUrls.add(videoUrl);

        allVideos.push({
          platform: 'meta',
          platformVideoId: String(adArchiveId),
          videoUrl,
          thumbnailUrl: extractMetaThumbnail(item),
          caption: extractMetaCaption(item),
          author: item.pageName || item.snapshot?.pageName || 'Meta Advertiser',
        });
      }
    } catch (error) {
      logger.warn('Meta Ad collector: Apify call error', { queries, error: error.message });
    }
  };

  const primary = buildMetaQueries(productAnalysis);
  await runQueries(primary, true);

  // Shortfall (after discounting already-seen ads): broaden to category-level keywords,
  // then go deeper into the primary searches. Any remaining deficit is reported to the UI.
  if (freshCount() < minResults) {
    const broad = buildBroadQueries(productAnalysis).filter((q) => !primary.includes(q));
    logger.info('Meta Ad collector: shortfall, broadening queries', {
      fresh: freshCount(),
      target: minResults,
      broad,
    });
    await runQueries(broad, false);
  }

  if (freshCount() < minResults) {
    logger.info('Meta Ad collector: still short, paging deeper', { fresh: freshCount(), target: minResults });
    await runQueries(primary, true, DEEP_RESULTS_PER_QUERY);
  }

  logger.info('Meta Ad collector: finished', { totalVideos: allVideos.length, fresh: freshCount() });
  return allVideos;
}

// Primary searches match the exact phrase; "unordered" matches ads containing any of the words
// (e.g. novels that mention a "t-shirt"), so it is only used when broadening.
function buildAdLibraryUrl(query, exactPhrase) {
  const params = new URLSearchParams({
    active_status: 'all',
    ad_type: 'all',
    country: 'ALL',
    media_type: 'video',
    q: query,
    search_type: exactPhrase ? 'keyword_exact_phrase' : 'keyword_unordered',
  });
  return `https://www.facebook.com/ads/library/?${params}`;
}

function buildMetaQueries(analysis) {
  const queries = [];
  const attrs = analysis.attributes || {};

  if (attrs.brand && attrs.productType) {
    queries.push(brandedProduct(attrs.brand, attrs.productType));
  }

  if (analysis.metaAdKeywords?.length) {
    queries.push(...analysis.metaAdKeywords.slice(0, 3));
  }

  if (attrs.productType) {
    queries.push(attrs.productType);
  }

  return [...new Set(queries.map((q) => q.toLowerCase().trim()).filter(Boolean))].slice(0, MAX_QUERIES_PER_RUN);
}

/**
 * Generic category-level keywords used only when specific ones fall short.
 */
function buildBroadQueries(analysis) {
  const attrs = analysis.attributes || {};
  const queries = [];

  if (attrs.productType) {
    const words = attrs.productType.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length > 1) queries.push(words.slice(-2).join(' '));
  }

  if (attrs.colors?.length && attrs.productType) {
    queries.push(`${attrs.colors[0]} ${attrs.productType}`.toLowerCase());
  }

  if (attrs.keyFeatures?.length && attrs.productType) {
    queries.push(`${attrs.keyFeatures[0]} ${attrs.productType}`.toLowerCase());
  }

  return [...new Set(queries)].slice(0, MAX_QUERIES_PER_RUN);
}

function hasVideoCreative(item) {
  const snap = item.snapshot || {};
  return (snap.videos || []).length > 0
    || (snap.cards || []).some((c) => c.videoHdUrl || c.videoSdUrl)
    || (snap.extraVideos || []).length > 0;
}

function extractMetaThumbnail(item) {
  const snap = item.snapshot || {};
  const card = (snap.cards || []).find((c) => c.videoPreviewImageUrl);
  return snap.videos?.[0]?.videoPreviewImageUrl
    || card?.videoPreviewImageUrl
    || snap.images?.[0]?.originalImageUrl
    || snap.images?.[0]?.resizedImageUrl
    || null;
}

// Dynamic product ads ship unrendered templates like "{{product.brand}}".
const isTemplate = (text) => /\{\{.*\}\}/.test(text);

function extractMetaCaption(item) {
  const snap = item.snapshot || {};
  const candidates = [
    snap.body?.text,
    ...(snap.cards || []).map((c) => c.body),
    snap.title,
    snap.linkDescription,
    ...(snap.cards || []).map((c) => c.title),
  ];
  return candidates.find((t) => typeof t === 'string' && t.trim() && !isTemplate(t)) || '';
}

module.exports = { collectMetaAds, buildMetaQueries, buildBroadQueries };
