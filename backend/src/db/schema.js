const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../utils/logger');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'discovery.db');

let db;

function getDb() {
  if (!db) {
    // Ensure data directory exists
    const fs = require('fs');
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
    logger.info('Database initialized', { path: DB_PATH });
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS searches (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      input_type TEXT NOT NULL CHECK(input_type IN ('keyword', 'url', 'image')),
      product_title TEXT,
      product_description TEXT,
      product_image_url TEXT,
      product_attributes TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
      error_message TEXT,
      instagram_count INTEGER DEFAULT 0,
      meta_count INTEGER DEFAULT 0,
      tiktok_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      search_id TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('instagram', 'meta', 'tiktok')),
      platform_video_id TEXT,
      video_url TEXT,
      thumbnail_url TEXT,
      caption TEXT,
      author TEXT,
      match_score REAL DEFAULT 0,
      match_reason TEXT,
      is_below_threshold INTEGER DEFAULT 0,
      media_url_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (search_id) REFERENCES searches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS seen_videos (
      video_hash TEXT NOT NULL,
      search_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (video_hash, search_id)
    );

    CREATE INDEX IF NOT EXISTS idx_videos_search_id ON videos(search_id);
    CREATE INDEX IF NOT EXISTS idx_videos_platform ON videos(platform);
    CREATE INDEX IF NOT EXISTS idx_seen_videos_hash ON seen_videos(video_hash);
    CREATE INDEX IF NOT EXISTS idx_searches_created ON searches(created_at DESC);
  `);

  // Migration: videos already returned by an earlier search are stored but hidden unless
  // the user turns on "Show previously seen".
  const videoColumns = db.prepare('PRAGMA table_info(videos)').all().map((c) => c.name);
  if (!videoColumns.includes('is_previously_seen')) {
    db.exec('ALTER TABLE videos ADD COLUMN is_previously_seen INTEGER DEFAULT 0');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_videos_media_hash ON videos(media_url_hash)');
}

module.exports = { getDb };
