const { describe, it } = require('node:test');
const assert = require('node:assert');
const { deduplicateVideos, hashCaption, getDeficit } = require('../services/deduplicator');

// Mock the database calls
const originalModule = require('../db/queries');
const originalGetSeenHashes = originalModule.getSeenVideoHashes;
originalModule.getSeenVideoHashes = () => new Set();

describe('De-duplication Engine', () => {
  it('should remove exact URL duplicates within a batch', () => {
    const videos = [
      { videoUrl: 'https://instagram.com/reel/abc123', platform: 'instagram', caption: 'Test 1' },
      { videoUrl: 'https://instagram.com/reel/abc123', platform: 'instagram', caption: 'Test 1 copy' },
      { videoUrl: 'https://instagram.com/reel/def456', platform: 'instagram', caption: 'Test 2' },
    ];

    const result = deduplicateVideos(videos, 'instagram', false);
    assert.strictEqual(result.length, 2);
  });

  it('should remove duplicate platform IDs', () => {
    const videos = [
      { videoUrl: 'https://ig.com/a', platformVideoId: 'vid123', platform: 'instagram', caption: 'A' },
      { videoUrl: 'https://ig.com/b', platformVideoId: 'vid123', platform: 'instagram', caption: 'B' },
      { videoUrl: 'https://ig.com/c', platformVideoId: 'vid456', platform: 'instagram', caption: 'C' },
    ];

    const result = deduplicateVideos(videos, 'instagram', false);
    assert.strictEqual(result.length, 2);
  });

  it('should detect near-duplicate captions from same author', () => {
    const videos = [
      {
        videoUrl: 'https://ig.com/1',
        platform: 'instagram',
        caption: 'Check out this amazing oversized graphic tee! Best quality ever!',
        author: 'fashionista',
      },
      {
        videoUrl: 'https://ig.com/2',
        platform: 'instagram',
        caption: 'Check out this amazing oversized graphic tee! Best quality ever!',
        author: 'fashionista',
      },
      {
        videoUrl: 'https://ig.com/3',
        platform: 'instagram',
        caption: 'Totally different product review here',
        author: 'techguy',
      },
    ];

    const result = deduplicateVideos(videos, 'instagram', false);
    assert.strictEqual(result.length, 2);
  });

  it('should allow same caption from different authors', () => {
    const videos = [
      {
        videoUrl: 'https://ig.com/1',
        platform: 'instagram',
        caption: 'Check out this amazing product review and unboxing video!',
        author: 'user1',
      },
      {
        videoUrl: 'https://ig.com/2',
        platform: 'instagram',
        caption: 'Check out this amazing product review and unboxing video!',
        author: 'user2',
      },
    ];

    const result = deduplicateVideos(videos, 'instagram', false);
    assert.strictEqual(result.length, 2);
  });

  it('should handle empty input gracefully', () => {
    const result = deduplicateVideos([], 'instagram', false);
    assert.strictEqual(result.length, 0);
  });
});

describe('Caption Hashing', () => {
  it('should return null for very short captions', () => {
    assert.strictEqual(hashCaption('hi', 'user'), null);
    assert.strictEqual(hashCaption('', 'user'), null);
    assert.strictEqual(hashCaption(null, 'user'), null);
  });

  it('should produce same hash for normalized similar captions', () => {
    const h1 = hashCaption('Check out this AMAZING product!', 'user1');
    const h2 = hashCaption('check   out  this  amazing  product', 'user1');
    assert.strictEqual(h1, h2);
  });

  it('should produce different hashes for different authors', () => {
    const h1 = hashCaption('Amazing product review and showcase video', 'author1');
    const h2 = hashCaption('Amazing product review and showcase video', 'author2');
    assert.notStrictEqual(h1, h2);
  });
});

describe('Deficit Calculation', () => {
  it('should return 0 when minimum is met', () => {
    assert.strictEqual(getDeficit(25, 20), 0);
  });

  it('should return correct deficit', () => {
    assert.strictEqual(getDeficit(15, 20), 5);
  });

  it('should return full minimum when count is 0', () => {
    assert.strictEqual(getDeficit(0, 20), 20);
  });
});

// Restore original
originalModule.getSeenVideoHashes = originalGetSeenHashes;
