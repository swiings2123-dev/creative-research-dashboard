const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { parseImageDataUrl } = require('../utils/imageUpload');
const db = require('../db/queries');
const { runSearchPipeline, addSSEListener, removeSSEListener, getProgress } = require('../services/searchPipeline');

/**
 * POST /api/search
 * Start a new product video search.
 * Body: { query?: string, image?: string } — product name/keyword or product URL, and/or an
 * uploaded product photo as a data URL (JPEG/PNG/WebP, max 3 MB). At least one is required.
 */
router.post('/', async (req, res) => {
  try {
    const { query, image } = req.body;
    const trimmedQuery = typeof query === 'string' ? query.trim() : '';

    if (image !== undefined && image !== null && !parseImageDataUrl(image)) {
      return res.status(400).json({
        error: 'Invalid image. Upload a JPEG, PNG or WebP photo up to 3 MB.',
      });
    }

    if (!trimmedQuery && !image) {
      return res.status(400).json({
        error: 'Missing input. Provide a product name, a product URL, or upload a product photo.',
      });
    }

    const isUrl = /^https?:\/\//i.test(trimmedQuery);
    const inputType = image ? 'image' : isUrl ? 'url' : 'keyword';

    logger.info('New search request', { query: trimmedQuery, inputType });

    // Create search record
    const searchId = db.createSearch({
      query: trimmedQuery || 'Image search',
      inputType,
    });

    // Run pipeline in background (non-blocking)
    runSearchPipeline(searchId, trimmedQuery, { image }).catch((err) => {
      logger.error('Pipeline failed in background', { searchId, error: err.message });
    });

    res.status(202).json({
      searchId,
      message: 'Search started. Use SSE endpoint to track progress.',
      progressUrl: `/api/search/${searchId}/progress`,
      resultsUrl: `/api/search/${searchId}`,
    });
  } catch (error) {
    logger.error('Search endpoint error', { error: error.message });
    res.status(500).json({ error: 'Failed to start search' });
  }
});

/**
 * GET /api/search/:id
 * Get search results by search ID.
 * Query params: platform, sortBy, showPreviouslySeen
 */
router.get('/:id', async (req, res) => {
  try {
    const search = db.getSearch(req.params.id);
    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    const { platform, sortBy, showPreviouslySeen } = req.query;

    const videos = db.getVideosBySearchId(req.params.id, {
      platform: platform || null,
      sortBy: sortBy || 'score_desc',
      showPreviouslySeen: showPreviouslySeen === 'true',
    });

    const counts = db.getSearchVideoCounts(req.params.id);

    res.json({
      search,
      videos,
      counts,
      total: videos.length,
    });
  } catch (error) {
    logger.error('Get search error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch search results' });
  }
});

/**
 * GET /api/search/:id/progress
 * SSE endpoint for real-time progress updates.
 */
router.get('/:id/progress', (req, res) => {
  const searchId = req.params.id;
  const search = db.getSearch(searchId);

  if (!search) {
    return res.status(404).json({ error: 'Search not found' });
  }

  // Setup SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send initial state
  res.write(`data: ${JSON.stringify({ type: 'connected', searchId, status: search.status })}\n\n`);

  // If already complete, send result immediately
  if (search.status === 'completed' || search.status === 'failed') {
    const counts = db.getSearchVideoCounts(searchId);
    res.write(`data: ${JSON.stringify({
      type: search.status === 'completed' ? 'complete' : 'error',
      ...counts,
      error: search.error_message,
    })}\n\n`);
    res.end();
    return;
  }

  // Register listener
  addSSEListener(searchId, res);

  // Cleanup on client disconnect
  req.on('close', () => {
    removeSSEListener(searchId, res);
  });
});

module.exports = router;
