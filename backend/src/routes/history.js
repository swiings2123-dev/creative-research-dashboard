const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const db = require('../db/queries');

/**
 * GET /api/history
 * Get search history with pagination.
 * Query params: limit (default 20), offset (default 0)
 */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    const searches = db.getSearchHistory(limit, offset);

    // Parse JSON fields
    const parsed = searches.map((s) => {
      if (s.product_attributes && typeof s.product_attributes === 'string') {
        try { s.product_attributes = JSON.parse(s.product_attributes); } catch (e) {}
      }
      return s;
    });

    res.json({
      searches: parsed,
      pagination: { limit, offset },
    });
  } catch (error) {
    logger.error('History endpoint error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch search history' });
  }
});

/**
 * DELETE /api/history/:id
 * Delete a search and its results.
 */
router.delete('/:id', async (req, res) => {
  try {
    const { getDb } = require('../db/schema');
    const dbConn = getDb();
    dbConn.prepare('DELETE FROM videos WHERE search_id = ?').run(req.params.id);
    dbConn.prepare('DELETE FROM searches WHERE id = ?').run(req.params.id);

    res.json({ message: 'Search deleted' });
  } catch (error) {
    logger.error('Delete history error', { error: error.message });
    res.status(500).json({ error: 'Failed to delete search' });
  }
});

module.exports = router;
