const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Use a throwaway SQLite file (each test file runs in its own process)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reelscope-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const db = require('../db/queries');
const { getDb } = require('../db/schema');
const { partitionVideos } = require('../services/deduplicator');

const reel = (id, extra = {}) => ({
  platform: 'instagram',
  platformVideoId: id,
  videoUrl: `https://www.instagram.com/reel/${id}/`,
  caption: `caption for ${id} with enough text`,
  author: `creator_${id}`,
  ...extra,
});

describe('Uniqueness across searches', () => {
  let firstSearch;

  before(() => {
    firstSearch = db.createSearch({ query: 'first', inputType: 'keyword' });
    db.insertVideos(firstSearch, [
      reel('aaa', { matchScore: 88, matchReason: 'AI: same tee' }),
      reel('bbb', { matchScore: 30, matchReason: 'AI: different product', isBelowThreshold: true }),
    ]);
  });

  after(() => {
    getDb().close(); // Windows can't delete an open SQLite file
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('splits a new batch into fresh and previously seen videos', () => {
    const { fresh, previouslySeen } = partitionVideos([reel('aaa'), reel('ccc'), reel('ccc'), reel('ddd')], 'instagram');
    assert.deepStrictEqual(fresh.map((v) => v.platformVideoId).sort(), ['ccc', 'ddd']);
    assert.deepStrictEqual(previouslySeen.map((v) => v.platformVideoId), ['aaa']);
  });

  it('reuses the stored score of a previously seen video', () => {
    const scores = db.getStoredScores([db.hashVideoUrl(reel('aaa').videoUrl)]);
    const stored = scores.get(db.hashVideoUrl(reel('aaa').videoUrl));
    assert.strictEqual(stored.match_score, 88);
    assert.strictEqual(stored.match_reason, 'AI: same tee');
  });

  it('hides previously seen videos unless the toggle is on, and does not count them', () => {
    const second = db.createSearch({ query: 'second', inputType: 'keyword' });
    db.insertVideos(second, [
      reel('ccc', { matchScore: 70 }),
      reel('aaa', { matchScore: 88, isPreviouslySeen: true }),
    ]);

    const hidden = db.getVideosBySearchId(second, { showPreviouslySeen: false });
    const shown = db.getVideosBySearchId(second, { showPreviouslySeen: true });

    assert.deepStrictEqual(hidden.map((v) => v.platform_video_id), ['ccc']);
    assert.strictEqual(shown.length, 2);
    assert.strictEqual(shown.find((v) => v.platform_video_id === 'aaa').is_previously_seen, 1);
    assert.strictEqual(db.getSearchVideoCounts(second).instagram, 1);
  });
});
