const { describe, it } = require('node:test');
const assert = require('node:assert');

// Tests run against the real scoring helpers exported by the image brain
const { scoreCaptionRelevance, scoreVideoHeuristic } = require('../services/imageBrain');
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
