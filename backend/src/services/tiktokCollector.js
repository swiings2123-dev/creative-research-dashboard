const { ApifyClient } = require('apify-client');
const config = require('../config');
const logger = require('../utils/logger');

const client = new ApifyClient({ token: config.apifyToken });

/**
 * (Optional) Collect TikTok videos using Apify's TikTok scraper.
 * Only runs when ENABLE_TIKTOK=true.
 */
async function collectTikTokVideos(productAnalysis, existingHashes = new Set(), minResults = 10) {
  if (!config.enableTiktok) {
    logger.info('TikTok collector: disabled');
    return [];
  }

  logger.info('TikTok collector: starting');

  const allVideos = [];
  const seenUrls = new Set();
  const queries = buildTikTokQueries(productAnalysis);

  for (const query of queries) {
    if (allVideos.length >= minResults + 5) break;

    try {
      const run = await client.actor('clockworks/free-tiktok-scraper').call(
        {
          searchQueries: [query],
          resultsPerPage: Math.min(20, minResults + 5 - allVideos.length),
          shouldDownloadVideos: false,
        },
        {
          timeout: config.apifyTimeoutSecs,
          memory: 512,
          log: null,
        }
      );

      const { items } = await client.dataset(run.defaultDatasetId).listItems();

      for (const item of items) {
        const videoUrl = item.webVideoUrl || item.videoUrl
          || `https://www.tiktok.com/@${item.authorMeta?.name}/video/${item.id}`;

        if (seenUrls.has(videoUrl)) continue;
        seenUrls.add(videoUrl);

        allVideos.push({
          platform: 'tiktok',
          platformVideoId: item.id || null,
          videoUrl,
          thumbnailUrl: item.videoMeta?.coverUrl || item.covers?.default || null,
          caption: item.text || item.description || '',
          author: item.authorMeta?.name || item.author || '',
        });
      }
    } catch (error) {
      logger.error('TikTok collector: query failed', { query, error: error.message });
    }
  }

  logger.info('TikTok collector: finished', { totalVideos: allVideos.length });
  return allVideos;
}

function buildTikTokQueries(analysis) {
  const queries = [];
  const attrs = analysis.attributes || {};

  if (analysis.searchQueries?.length) {
    queries.push(...analysis.searchQueries.slice(0, 3));
  }

  if (attrs.productType) {
    queries.push(`${attrs.productType} review`);
  }

  return [...new Set(queries)].slice(0, 5);
}

module.exports = { collectTikTokVideos };
