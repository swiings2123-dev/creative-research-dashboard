/**
 * Loads recorded live searches (demo/recorded-searches.json) into the local database so the
 * dashboard can be explored without spending Apify credit. Each recorded search shows up in
 * Search History with a "(recorded <date>)" suffix. Safe to re-run: already-loaded searches are skipped.
 *
 * Usage: npm run seed:demo
 */
const path = require('path');
const fs = require('fs');
const db = require('../src/db/queries');
const { getDb } = require('../src/db/schema');

const RECORDED_FILE = path.join(__dirname, '..', 'demo', 'recorded-searches.json');

function recordedLabel(recordedAt) {
  const date = new Date(recordedAt);
  return `(recorded ${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })})`;
}

function seedRecorded({ quiet = false } = {}) {
  const log = quiet ? () => {} : console.log;
  const recorded = JSON.parse(fs.readFileSync(RECORDED_FILE, 'utf-8'));
  const conn = getDb();
  let loaded = 0;

  for (const rec of recorded) {
    const query = `${rec.query} ${recordedLabel(rec.recordedAt)}`;
    if (conn.prepare('SELECT 1 FROM searches WHERE query = ?').get(query)) {
      log(`skip (already loaded): ${query}`);
      continue;
    }

    const searchId = db.createSearch({
      query,
      inputType: rec.inputType,
      productTitle: rec.productTitle,
      productDescription: rec.productDescription,
      productImageUrl: rec.productImageUrl,
      productAttributes: rec.productAttributes,
    });

    db.insertVideos(searchId, rec.videos);

    const count = (platform) => rec.videos.filter((v) => v.platform === platform).length;
    db.updateSearch(searchId, {
      status: 'completed',
      instagramCount: count('instagram'),
      metaCount: count('meta'),
      tiktokCount: count('tiktok'),
      // created_at uses SQLite's CURRENT_TIMESTAMP format so history sorting stays consistent
      createdAt: rec.recordedAt.replace('T', ' ').slice(0, 19),
      completedAt: rec.recordedAt,
    });

    loaded++;
    log(`loaded: ${query} (${rec.videos.length} videos)`);
  }

  log(`Done. ${loaded} recorded search(es) added.`);
  return loaded;
}

if (require.main === module) {
  seedRecorded();
}

module.exports = { seedRecorded };
