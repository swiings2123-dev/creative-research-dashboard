const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');
const config = require('../config');

// Tests run against the real scoring helpers exported by the image brain
const { scoreCaptionRelevance, scoreVideoHeuristic, analyzeProductImage, scoreVideos } = require('../services/imageBrain');
const { brandedProduct } = require('../utils/queryText');
const { parseImageDataUrl } = require('../utils/imageUpload');

describe('Scoring Logic', () => {
  const mockAnalysis = {
    attributes: {
      productType: 'graphic tee',
      colors: ['black', 'white'],
      brand: 'Nike',
      keyFeatures: ['oversized', 'cotton', 'streetwear'],
    },
  };

  it('should give high score when caption matches product type and colors', () => {
    const result = scoreCaptionRelevance(
      'Check out this black graphic tee! Perfect for streetwear',
      mockAnalysis
    );
    assert.ok(result.score > 30, `Score should be > 30, got ${result.score}`);
    assert.ok(result.reason.includes('product type'));
  });

  it('should give high score when brand is mentioned', () => {
    const result = scoreCaptionRelevance(
      'New Nike collection just dropped',
      mockAnalysis
    );
    assert.ok(result.score > 0, `Score should be > 0, got ${result.score}`);
    assert.ok(result.reason.includes('Nike'));
  });

  it('should give low score for unrelated caption', () => {
    const result = scoreCaptionRelevance(
      'Beautiful sunset at the beach today',
      mockAnalysis
    );
    assert.ok(result.score < 30, `Score should be < 30, got ${result.score}`);
  });

  it('should handle empty caption', () => {
    const result = scoreCaptionRelevance('', mockAnalysis);
    assert.strictEqual(result.score, 20);
  });

  it('should handle null caption', () => {
    const result = scoreCaptionRelevance(null, mockAnalysis);
    assert.strictEqual(result.score, 20);
  });

  it('should handle analysis without attributes', () => {
    const result = scoreCaptionRelevance('some video caption', { attributes: {} });
    assert.ok(result.score >= 0);
  });

  it('should match multiple attributes and accumulate score', () => {
    const result = scoreCaptionRelevance(
      'Black and white Nike graphic tee, oversized cotton streetwear look',
      mockAnalysis
    );
    assert.ok(result.score > 70, `Score should be > 70, got ${result.score}`);
  });
});

describe('Heuristic fallback score', () => {
  const analysis = {
    attributes: { productType: 'graphic tee', colors: ['black'], brand: '', keyFeatures: [] },
    searchQueries: ['black graphic tee'],
  };

  it('ranks an on-topic caption above an unrelated one', () => {
    const onTopic = scoreVideoHeuristic({ caption: 'My new black graphic tee fit check' }, analysis);
    const offTopic = scoreVideoHeuristic({ caption: 'Sunset at the beach with friends' }, analysis);
    assert.ok(onTopic.score > offTopic.score);
    assert.ok(onTopic.score >= 0 && onTopic.score <= 100);
  });

  it('labels fallback reasons so the UI can tell them apart from AI verdicts', () => {
    const result = scoreVideoHeuristic({ caption: 'black graphic tee' }, analysis);
    assert.ok(result.reason.startsWith('Keyword match'));
  });
});

describe('Query building helpers', () => {
  it('does not repeat a brand already in the product type', () => {
    assert.strictEqual(brandedProduct('Nike', 'nike shoes'), 'nike shoes');
    assert.strictEqual(brandedProduct('Nike', 'running shoes'), 'Nike running shoes');
    assert.strictEqual(brandedProduct('', 'running shoes'), 'running shoes');
  });
});

describe('Uploaded image validation', () => {
  it('accepts image data URLs and rejects everything else', () => {
    assert.ok(parseImageDataUrl('data:image/png;base64,iVBORw0KGgo='));
    assert.strictEqual(parseImageDataUrl('data:text/html;base64,PGh0bWw+'), null);
    assert.strictEqual(parseImageDataUrl('https://example.com/a.png'), null);
    assert.strictEqual(parseImageDataUrl(42), null);
  });
});

// Gemini's JSON response is schema-validated (StructuredOutputParser) rather than a
// bare JSON.parse(). Each test sets axios.post to its own self-contained mock (no
// variable shared across tests) and restores it afterwards - node:test can run
// sibling `it`s concurrently by default, and a shared mutable mock response was
// confirmed live to cause real cross-test interference (one test's response
// leaking into another's assertions) when these were written as a single shared
// beforeEach mock instead.
describe('Gemini response schema validation', () => {
  let originalPost;
  let originalKey;

  beforeEach(() => {
    originalPost = axios.post;
    originalKey = config.geminiApiKey;
    // config.geminiApiKey is read from process.env once at module-load time
    // (see src/config/index.js) - confirmed live that setting the env var
    // here has no effect, since config was already required (and its
    // snapshot taken) before this test file's imports even finish. Mutate
    // the already-loaded config object directly instead.
    config.geminiApiKey = 'fake-key-for-test';
  });

  afterEach(() => {
    axios.post = originalPost;
    config.geminiApiKey = originalKey;
  });

  it('passes through a fully valid response unchanged', async () => {
    const text = JSON.stringify({ productType: 'running shoe', colors: ['red', 'white'], brand: 'Nike', searchQueries: ['red nike shoes'] });
    axios.post = async () => ({ data: { candidates: [{ content: { parts: [{ text }] } }] } });
    const result = await analyzeProductImage(null, 'Schema test: fully valid', '');
    assert.strictEqual(result.isFallback, undefined);
    assert.strictEqual(result.attributes.brand, 'Nike');
    assert.deepStrictEqual(result.attributes.colors, ['red', 'white']);
  });

  it('keeps correctly-typed fields and defaults only the bad one, instead of discarding the whole response', async () => {
    // colors is a string, not an array - the kind of single-field slip a stricter
    // schema would reject outright, throwing away the correctly-identified brand too.
    const text = JSON.stringify({ productType: 'earbuds', colors: 'black', brand: 'Sony', searchQueries: ['sony earbuds'] });
    axios.post = async () => ({ data: { candidates: [{ content: { parts: [{ text }] } }] } });
    const result = await analyzeProductImage(null, 'Schema test: one bad field', '');
    assert.strictEqual(result.isFallback, undefined, 'a single bad field should not trigger full heuristic fallback');
    assert.strictEqual(result.attributes.brand, 'Sony');
    assert.deepStrictEqual(result.attributes.colors, []);
  });

  it('falls back to heuristic analysis on genuinely malformed (non-JSON) text', async () => {
    const text = '{"productType": "truncated';
    axios.post = async () => ({ data: { candidates: [{ content: { parts: [{ text }] } }] } });
    const result = await analyzeProductImage(null, 'Schema test: truncated', '');
    assert.strictEqual(result.isFallback, true);
  });

  it('coerces string index/score in video-scoring responses instead of rejecting the batch', async () => {
    const text = JSON.stringify([
      { index: '0', score: '85', reason: 'matches' },
      { index: '1', score: '20', reason: 'different brand' },
    ]);
    axios.post = async () => ({ data: { candidates: [{ content: { parts: [{ text }] } }] } });
    const videos = [
      { platform: 'instagram', caption: 'red nike shoes', author: 'a', thumbnailUrl: null },
      { platform: 'instagram', caption: 'blue adidas shoes', author: 'b', thumbnailUrl: null },
    ];
    const scored = await scoreVideos(videos, { attributes: { productType: 'shoe' }, searchQueries: ['nike shoes'] });
    assert.strictEqual(scored[0].matchScore, 85);
    assert.strictEqual(scored[1].matchScore, 20);
    assert.ok(scored[0].matchReason.startsWith('AI:'), 'should use the AI score, not fall back to heuristic');
  });
});
