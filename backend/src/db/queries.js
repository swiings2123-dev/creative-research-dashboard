const { getDb } = require('./schema');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// ─── Searches ──────────────────────────────────────────────

function createSearch({ query, inputType, productTitle, productDescription, productImageUrl, productAttributes }) {
  const db = getDb();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO searches (id, query, input_type, product_title, product_description, product_image_url, product_attributes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')
  `).run(id, query, inputType, productTitle || null, productDescription || null, productImageUrl || null, productAttributes ? JSON.stringify(productAttributes) : null);
  return id;
}

function updateSearch(id, updates) {
  const db = getDb();
  const fields = [];
  const values = [];
  for (const [key, value] of Object.entries(updates)) {
    // Convert camelCase to snake_case
    const snakeKey = key.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
    fields.push(`${snakeKey} = ?`);
    // typeof null === 'object': store real NULLs, not the string "null"
    values.push(value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
  }
  values.push(id);
  db.prepare(`UPDATE searches SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

function getSearch(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM searches WHERE id = ?').get(id);
  if (row && row.product_attributes) {
    try { row.product_attributes = JSON.parse(row.product_attributes); } catch (e) {}
  }
  return row;
}

function getSearchHistory(limit = 20, offset = 0) {
  const db = getDb();
  return db.prepare('SELECT * FROM searches ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
}

// ─── Videos ──────────────────────────────────────────────

function hashVideoUrl(url) {
  return crypto.createHash('sha256').update(url || '').digest('hex').slice(0, 32);
}

function insertVideos(searchId, videos) {
  const db = getDb();
  const insertVideo = db.prepare(`
    INSERT OR IGNORE INTO videos (id, search_id, platform, platform_video_id, video_url, thumbnail_url, caption, author, match_score, match_reason, is_below_threshold, media_url_hash, is_previously_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSeen = db.prepare(`
    INSERT OR IGNORE INTO seen_videos (video_hash, search_id, platform)
    VALUES (?, ?, ?)
  `);

  const insertMany = db.transaction((vids) => {
    for (const v of vids) {
      const id = uuidv4();
      const urlHash = hashVideoUrl(v.videoUrl || v.video_url);
      insertVideo.run(
        id, searchId, v.platform,
        v.platformVideoId || v.platform_video_id || null,
        v.videoUrl || v.video_url || null,
        v.thumbnailUrl || v.thumbnail_url || null,
        v.caption || null,
        v.author || null,
        v.matchScore || v.match_score || 0,
        v.matchReason || v.match_reason || null,
        v.isBelowThreshold || v.is_below_threshold ? 1 : 0,
        urlHash,
        v.isPreviouslySeen || v.is_previously_seen ? 1 : 0
      );
      insertSeen.run(urlHash, searchId, v.platform);
    }
  });

  insertMany(videos);
}

function getVideosBySearchId(searchId, { platform, sortBy, showPreviouslySeen } = {}) {
  const db = getDb();
  let query = 'SELECT * FROM videos WHERE search_id = ?';
  const params = [searchId];

  if (platform) {
    query += ' AND platform = ?';
    params.push(platform);
  }

  if (!showPreviouslySeen) {
    query += ' AND is_previously_seen = 0';
  }

  switch (sortBy) {
    case 'score_desc':
      query += ' ORDER BY match_score DESC';
      break;
    case 'score_asc':
      query += ' ORDER BY match_score ASC';
      break;
    case 'newest':
      query += ' ORDER BY created_at DESC';
      break;
    default:
      query += ' ORDER BY match_score DESC';
  }

  return db.prepare(query).all(...params);
}

// ─── De-duplication ──────────────────────────────────────

function getSeenVideoHashes(platform) {
  const db = getDb();
  const rows = db.prepare('SELECT DISTINCT video_hash FROM seen_videos WHERE platform = ?').all(platform);
  return new Set(rows.map((r) => r.video_hash));
}

function isVideoSeen(videoUrl) {
  const db = getDb();
  const hash = hashVideoUrl(videoUrl);
  const row = db.prepare('SELECT 1 FROM seen_videos WHERE video_hash = ?').get(hash);
  return !!row;
}

/**
 * Most recent stored score for each media-URL hash, so videos returned again by a later
 * search can reuse their score instead of being re-analysed.
 */
function getStoredScores(hashes) {
  const db = getDb();
  const lookup = db.prepare(`
    SELECT match_score, match_reason, is_below_threshold FROM videos
    WHERE media_url_hash = ? ORDER BY created_at DESC LIMIT 1
  `);
  const scores = new Map();
  for (const hash of hashes) {
    const row = lookup.get(hash);
    if (row) scores.set(hash, row);
  }
  return scores;
}

function getSearchVideoCounts(searchId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT platform, COUNT(*) as count FROM videos WHERE search_id = ? AND is_previously_seen = 0 GROUP BY platform
  `).all(searchId);
  const counts = { instagram: 0, meta: 0, tiktok: 0 };
  for (const r of rows) {
    counts[r.platform] = r.count;
  }
  return counts;
}

module.exports = {
  createSearch,
  updateSearch,
  getSearch,
  getSearchHistory,
  hashVideoUrl,
  insertVideos,
  getVideosBySearchId,
  getSeenVideoHashes,
  isVideoSeen,
  getStoredScores,
  getSearchVideoCounts,
};
