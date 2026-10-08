const config = require('../config');
const logger = require('../utils/logger');
const { resolveProduct } = require('./productResolver');
const { analyzeProductImage, scoreVideos, scoreVideoHeuristic } = require('./imageBrain');
const { collectInstagramReels } = require('./instagramCollector');
const { collectMetaAds } = require('./metaAdCollector');
const { collectTikTokVideos } = require('./tiktokCollector');
const { partitionVideos, getDeficit } = require('./deduplicator');
const db = require('../db/queries');
const { brandedProduct } = require('../utils/queryText');

const titleCase = (text) => text.replace(/\b\w/g, (c) => c.toUpperCase());

// In-memory progress tracking per search
const progressMap = new Map();

function getProgress(searchId) {
  return progressMap.get(searchId) || { steps: [], status: 'unknown' };
}

function emitProgress(searchId, step, detail = '') {
  if (!progressMap.has(searchId)) {
    progressMap.set(searchId, { steps: [], status: 'processing' });
  }
  const progress = progressMap.get(searchId);
  const entry = { step, detail, timestamp: new Date().toISOString() };
  progress.steps.push(entry);
  progress.currentStep = step;
  progress.currentDetail = detail;

  // Notify SSE listeners
  const listeners = sseListeners.get(searchId) || [];
  for (const res of listeners) {
    try {
      res.write(`data: ${JSON.stringify({ type: 'progress', ...entry })}\n\n`);
    } catch (e) {}
  }
}

// SSE listener management
const sseListeners = new Map();

function addSSEListener(searchId, res) {
  if (!sseListeners.has(searchId)) {
    sseListeners.set(searchId, []);
  }
  sseListeners.get(searchId).push(res);

  // Send current progress
  const progress = progressMap.get(searchId);
  if (progress) {
    for (const step of progress.steps) {
      res.write(`data: ${JSON.stringify({ type: 'progress', ...step })}\n\n`);
    }
  }
}

function removeSSEListener(searchId, res) {
  const listeners = sseListeners.get(searchId) || [];
  const idx = listeners.indexOf(res);
  if (idx !== -1) listeners.splice(idx, 1);
}

function notifyComplete(searchId, result) {
  const listeners = sseListeners.get(searchId) || [];
  for (const res of listeners) {
    try {
      res.write(`data: ${JSON.stringify({ type: 'complete', ...result })}\n\n`);
    } catch (e) {}
  }
  // Clean up after a delay
  setTimeout(() => {
    progressMap.delete(searchId);
    sseListeners.delete(searchId);
  }, 60000);
}

/**
 * Main search pipeline. Runs asynchronously.
 * 
 * Flow:
 * 1. Resolve product (URL scraping or keyword)
 * 2. Analyze product image with Gemini Vision
 * 3. Collect videos from Instagram + Meta (parallel) + TikTok (optional)
 * 4. De-duplicate against history
 * 5. Score each video against product
 * 6. Store and return results
 */
async function runSearchPipeline(searchId, input, { image } = {}) {
  try {
    emitProgress(searchId, 'resolving', image ? 'Reading uploaded product photo...' : 'Resolving product information...');

    // Step 1: Resolve product (an uploaded photo is used as-is; any text is its title)
    const product = image
      ? { inputType: 'image', title: input, description: '', imageUrl: image, source: 'upload' }
      : await resolveProduct(input);
    
    db.updateSearch(searchId, {
      productTitle: product.title,
      productDescription: product.description,
      productImageUrl: product.imageUrl,
    });

    emitProgress(searchId, 'analyzing', 'Analyzing product with AI vision...');

    // Step 2: Analyze product image
    const analysis = await analyzeProductImage(
      product.imageUrl,
      product.title,
      product.description
    );

    // A photo-only search needs the vision model to know what to look for
    if (image && !product.title && analysis.isFallback) {
      throw new Error(
        "Couldn't recognise the product in the uploaded photo (the vision AI didn't respond in time). " +
        'Add a product name with the photo, or try again in a minute.'
      );
    }

    db.updateSearch(searchId, {
      productAttributes: analysis.attributes,
      // Photo-only searches are titled by what the AI recognised
      ...(!product.title && analysis.attributes?.productType
        ? { productTitle: titleCase(brandedProduct(analysis.attributes.brand, analysis.attributes.productType)) }
        : {}),
    });

    // Add imageUrl to analysis for scoring
    analysis.imageUrl = product.imageUrl;

    emitProgress(searchId, 'collecting', 'Searching Instagram Reels and Meta Ad Library in parallel...');

    // Step 3: Collect videos in parallel
    const MIN = config.minVideosPerSource;

    const [instagramRaw, metaRaw, tiktokRaw] = await Promise.allSettled([
      collectInstagramReels(analysis, db.getSeenVideoHashes('instagram'), MIN).then((videos) => {
        emitProgress(searchId, 'collected_instagram', `Instagram: ${videos.length} reels collected`);
        return videos;
      }),
      collectMetaAds(analysis, db.getSeenVideoHashes('meta'), MIN).then((videos) => {
        emitProgress(searchId, 'collected_meta', `Meta Ad Library: ${videos.length} video ads collected`);
        return videos;
      }),
      collectTikTokVideos(analysis, db.getSeenVideoHashes('tiktok')),
    ]);

    const instagramVideos = instagramRaw.status === 'fulfilled' ? instagramRaw.value : [];
    const metaVideos = metaRaw.status === 'fulfilled' ? metaRaw.value : [];
    const tiktokVideos = tiktokRaw.status === 'fulfilled' ? tiktokRaw.value : [];

    if (instagramRaw.status === 'rejected') {
      logger.error('Instagram collection failed', { error: instagramRaw.reason?.message });
      emitProgress(searchId, 'instagram_error', `Instagram: ${instagramRaw.reason?.message}`);
    }
    if (metaRaw.status === 'rejected') {
      logger.error('Meta collection failed', { error: metaRaw.reason?.message });
      emitProgress(searchId, 'meta_error', `Meta: ${metaRaw.reason?.message}`);
    }

    emitProgress(searchId, 'deduplicating', `De-duplicating ${instagramVideos.length + metaVideos.length + tiktokVideos.length} videos...`);

    // Step 4: De-duplicate within the batch and split off videos returned by earlier searches
    const ig = partitionVideos(instagramVideos, 'instagram');
    const meta = partitionVideos(metaVideos, 'meta');
    const tiktok = partitionVideos(tiktokVideos, 'tiktok');

    // Check deficits (only unseen videos count toward the minimum)
    const igDeficit = getDeficit(ig.fresh.length, MIN);
    const metaDeficit = getDeficit(meta.fresh.length, MIN);

    if (igDeficit > 0) {
      emitProgress(searchId, 'shortfall', `Instagram: ${ig.fresh.length}/${MIN} new videos after broadened and deeper searches. Shortfall of ${igDeficit} flagged.`);
    }
    if (metaDeficit > 0) {
      emitProgress(searchId, 'shortfall', `Meta: ${meta.fresh.length}/${MIN} new videos after broadened and deeper searches. Shortfall of ${metaDeficit} flagged.`);
    }

    emitProgress(searchId, 'scoring', 'Scoring videos against product...');

    // Step 5: Score new videos; previously seen ones reuse their stored score
    const scoredIG = await scoreVideoBatch(ig.fresh, analysis);
    const scoredMeta = await scoreVideoBatch(meta.fresh, analysis);
    const scoredTiktok = await scoreVideoBatch(tiktok.fresh, analysis);
    const seenVideos = [
      ...withStoredScores(ig.previouslySeen, analysis),
      ...withStoredScores(meta.previouslySeen, analysis),
      ...withStoredScores(tiktok.previouslySeen, analysis),
    ];

    emitProgress(searchId, 'saving', 'Saving results...');

    // Step 6: Store results
    db.insertVideos(searchId, scoredIG);
    db.insertVideos(searchId, scoredMeta);
    if (scoredTiktok.length > 0) {
      db.insertVideos(searchId, scoredTiktok);
    }
    // Hidden unless the user turns on "Show previously seen"
    db.insertVideos(searchId, seenVideos);

    // Update search record
    db.updateSearch(searchId, {
      status: 'completed',
      instagramCount: scoredIG.length,
      metaCount: scoredMeta.length,
      tiktokCount: scoredTiktok.length,
      completedAt: new Date().toISOString(),
    });

    const result = {
      searchId,
      instagram: scoredIG.length,
      meta: scoredMeta.length,
      tiktok: scoredTiktok.length,
      total: scoredIG.length + scoredMeta.length + scoredTiktok.length,
    };

    emitProgress(searchId, 'complete', `Found ${result.total} videos total`);
    notifyComplete(searchId, result);

    logger.info('Search pipeline complete', result);
    return result;

  } catch (error) {
    logger.error('Search pipeline failed', { searchId, error: error.message, stack: error.stack });
    
    db.updateSearch(searchId, {
      status: 'failed',
      errorMessage: error.message,
    });

    emitProgress(searchId, 'error', error.message);
    notifyComplete(searchId, { error: error.message });

    throw error;
  }
}

/**
 * Attach the score each previously seen video got in an earlier search (falls back to the
 * text heuristic if that search was deleted) and mark it as previously seen.
 */
function withStoredScores(videos, analysis) {
  const capped = videos.slice(0, MAX_SCORED_PER_PLATFORM);
  const stored = db.getStoredScores(capped.map((v) => db.hashVideoUrl(v.videoUrl)));
  return capped.map((video) => {
    const prior = stored.get(db.hashVideoUrl(video.videoUrl));
    const score = prior
      ? { matchScore: prior.match_score, matchReason: prior.match_reason, isBelowThreshold: prior.is_below_threshold === 1 }
      : (() => {
        const h = scoreVideoHeuristic(video, analysis);
        return { matchScore: h.score, matchReason: h.reason, isBelowThreshold: h.score < config.matchThreshold };
      })();
    return { ...video, ...score, isPreviouslySeen: true };
  });
}

// Collectors return candidates in query-priority order; only the first N per platform
// are AI-scored and kept, which bounds Gemini calls (N / 12 batches) per platform.
const MAX_SCORED_PER_PLATFORM = 48;

/**
 * Score a platform's videos and sort by match score, best first.
 */
async function scoreVideoBatch(videos, analysis) {
  const candidates = videos.slice(0, MAX_SCORED_PER_PLATFORM);
  const scores = await scoreVideos(candidates, analysis);
  const results = candidates.map((video, i) => ({ ...video, ...scores[i] }));

  results.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
  return results;
}

module.exports = { runSearchPipeline, getProgress, addSSEListener, removeSSEListener };
