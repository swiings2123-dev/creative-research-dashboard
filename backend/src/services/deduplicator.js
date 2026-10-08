const crypto = require('crypto');
const logger = require('../utils/logger');
const { getSeenVideoHashes, hashVideoUrl } = require('../db/queries');

/**
 * De-duplication engine.
 * 
 * Strategy:
 * 1. Hash-based: SHA-256 hash of video URL to detect exact duplicates
 * 2. Platform ID: Use platform-specific video IDs to catch reposts
 * 3. Near-duplicate: Detect re-uploads by comparing caption similarity + same author
 * 4. Cross-search: Filter videos already returned in previous searches
 */

/**
 * De-duplicate a list of videos against previously seen videos
 * and internal duplicates within the same batch.
 */
function deduplicateVideos(videos, platform, filterPreviouslySeen = true) {
  const seen = filterPreviouslySeen ? getSeenVideoHashes(platform) : new Set();
  const batchUrls = new Set();
  const batchPlatformIds = new Set();
  const batchCaptionHashes = new Set();
  const result = [];
  let duplicatesRemoved = 0;

  for (const video of videos) {
    // 1. URL-based dedup
    const urlHash = hashVideoUrl(video.videoUrl);
    if (seen.has(urlHash) || batchUrls.has(urlHash)) {
      duplicatesRemoved++;
      continue;
    }

    // 2. Platform ID dedup
    if (video.platformVideoId) {
      const pidKey = `${platform}:${video.platformVideoId}`;
      if (batchPlatformIds.has(pidKey)) {
        duplicatesRemoved++;
        continue;
      }
      batchPlatformIds.add(pidKey);
    }

    // 3. Near-duplicate detection (same author + very similar caption)
    const captionHash = hashCaption(video.caption, video.author);
    if (captionHash && batchCaptionHashes.has(captionHash)) {
      duplicatesRemoved++;
      continue;
    }
    if (captionHash) batchCaptionHashes.add(captionHash);

    batchUrls.add(urlHash);
    result.push(video);
  }

  logger.info('De-duplication complete', {
    platform,
    input: videos.length,
    output: result.length,
    duplicatesRemoved,
    previouslySeen: seen.size,
  });

  return result;
}

/**
 * Remove in-batch duplicates and near-duplicates, then split the rest into videos the user
 * has not seen yet (`fresh`) and ones already returned by an earlier search (`previouslySeen`).
 */
function partitionVideos(videos, platform) {
  const seenBefore = getSeenVideoHashes(platform);
  const unique = deduplicateVideos(videos, platform, false);
  const fresh = [];
  const previouslySeen = [];
  for (const video of unique) {
    (seenBefore.has(hashVideoUrl(video.videoUrl)) ? previouslySeen : fresh).push(video);
  }
  logger.info('Partitioned videos', { platform, fresh: fresh.length, previouslySeen: previouslySeen.length });
  return { fresh, previouslySeen };
}

/**
 * Create a hash for near-duplicate detection.
 * Normalizes caption by removing whitespace, lowercasing, and removing emojis,
 * then combines with author for a fingerprint.
 */
function hashCaption(caption, author) {
  if (!caption || caption.length < 10) return null;

  const normalized = caption
    .toLowerCase()
    .replace(/[\s\n\r]+/g, ' ')     // normalize whitespace
    .replace(/[^\w\s]/g, '')          // remove special chars
    .replace(/\b(the|a|an|and|or|is|in|on|at|to|for)\b/g, '') // remove stop words
    .trim()
    .slice(0, 100);                   // only compare first 100 chars

  if (normalized.length < 5) return null;

  const fingerprint = `${(author || '').toLowerCase()}:${normalized}`;
  return crypto.createHash('md5').update(fingerprint).digest('hex');
}

/**
 * Check if adding more videos is needed after de-duplication.
 * Returns the deficit count.
 */
function getDeficit(currentCount, minRequired) {
  return Math.max(0, minRequired - currentCount);
}

module.exports = { deduplicateVideos, partitionVideos, hashCaption, getDeficit };
