const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const { parseImageDataUrl, describeImage } = require('../utils/imageUpload');
const NodeCache = require('node-cache');

// Cache image analysis results for 2 hours
const analysisCache = new NodeCache({ stdTTL: 7200 });

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// model -> UTC day on which its daily quota ran out
const exhaustedModels = new Map();

function isDailyQuotaError(error) {
  if (error.response?.status !== 429) return false;
  const details = error.response.data?.error?.details || [];
  return details.some((d) => (d.violations || []).some((v) => /PerDay/i.test(v.quotaId || '')));
}

/**
 * POST generateContent, walking the configured model chain. A model whose daily quota is
 * exhausted (or that no longer exists) is skipped for the rest of the UTC day; any other
 * error is thrown so the caller can retry or fall back.
 */
async function callGemini(body, timeout) {
  const today = new Date().toISOString().slice(0, 10);
  let lastError = null;

  for (const model of config.geminiModels) {
    if (exhaustedModels.get(model) === today) continue;

    try {
      return await axios.post(`${GEMINI_API_BASE}/${model}:generateContent?key=${config.geminiApiKey}`, body, { timeout });
    } catch (error) {
      const status = error.response?.status;
      if (isDailyQuotaError(error) || status === 404) {
        logger.warn('Gemini: model unavailable, switching to next', { model, status });
        exhaustedModels.set(model, today);
        lastError = error;
        continue;
      }
      // Overloaded or too slow right now: try the next model, but don't rule this one out for the day
      if (error.code === 'ECONNABORTED' || status === 500 || status === 503) {
        logger.warn('Gemini: model busy or timed out, trying next', { model, status, error: error.message });
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('No Gemini model available');
}

/**
 * Analyse a product image using Google Gemini Vision API.
 * Extracts visual attributes to power search queries and scoring.
 */
async function analyzeProductImage(imageUrl, productTitle = '', productDescription = '') {
  // Hash the image reference so uploaded photos (long data URLs) make compact cache keys
  const cacheKey = `analysis:${crypto.createHash('sha1').update(imageUrl || productTitle || '').digest('hex')}:${productTitle}`;
  const cached = analysisCache.get(cacheKey);
  if (cached) {
    logger.info('Image brain: cache hit', { key: cacheKey });
    return cached;
  }

  if (!config.geminiApiKey || config.geminiApiKey === 'your_gemini_api_key_here') {
    logger.info('Image brain: Gemini API key not configured, using heuristic visual analysis');
    const fallback = generateFallbackAnalysis(productTitle, productDescription);
    analysisCache.set(cacheKey, fallback);
    return fallback;
  }

  logger.info('Image brain: analyzing with Gemini Vision', { image: describeImage(imageUrl), productTitle });

  const prompt = buildAnalysisPrompt(productTitle, productDescription);

  try {
    let parts = [{ text: prompt }];

    // If we have an image URL and it downloads, include it
    const image = imageUrl ? await fetchImage(imageUrl) : null;
    if (image) {
      parts = [{ inlineData: image }, { text: prompt }];
    }

    const response = await callGemini(
      {
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingLevel: 'low' },
        },
      },
      // Photo analysis on the free tier can take 25s+; leave headroom before falling back
      60000
    );

    const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty response from Gemini');

    const analysis = JSON.parse(text);
    const result = normalizeAnalysis(analysis, productTitle);

    analysisCache.set(cacheKey, result);
    logger.info('Image brain: analysis complete', { attributes: result.attributes });

    return result;
  } catch (error) {
    logger.error('Image brain: analysis failed', { error: error.message });
    // Fallback: generate basic analysis from title/description
    return generateFallbackAnalysis(productTitle, productDescription);
  }
}

const AI_BATCH_SIZE = 24;
const AI_CONCURRENCY = 2;

/**
 * Score videos against the product analysis.
 *
 * Primary: Gemini judges each video's thumbnail + caption against the product in batches
 * (one multimodal call per AI_BATCH_SIZE videos). This handles multilingual captions and
 * catches irrelevant creatives that merely mention a keyword.
 * Fallback (no key, or a batch fails): caption attribute match + query overlap heuristic.
 *
 * Returns scoring fields in the same order as `videos`.
 */
async function scoreVideos(videos, productAnalysis) {
  const results = new Array(videos.length);
  const aiEnabled = config.geminiApiKey && config.geminiApiKey !== 'your_gemini_api_key_here';

  if (aiEnabled) {
    const productImage = productAnalysis.imageUrl ? await fetchImage(productAnalysis.imageUrl) : null;
    const batches = [];
    for (let i = 0; i < videos.length; i += AI_BATCH_SIZE) {
      batches.push({ start: i, items: videos.slice(i, i + AI_BATCH_SIZE) });
    }

    for (let i = 0; i < batches.length; i += AI_CONCURRENCY) {
      await Promise.all(batches.slice(i, i + AI_CONCURRENCY).map(async ({ start, items }) => {
        const scored = await scoreBatchWithAI(items, productAnalysis, productImage);
        scored.forEach((r, j) => { if (r) results[start + j] = r; });
      }));
    }
  }

  let fallbackCount = 0;
  for (let i = 0; i < videos.length; i++) {
    if (!results[i]) {
      results[i] = scoreVideoHeuristic(videos[i], productAnalysis);
      fallbackCount++;
    }
  }

  logger.info('Scoring complete', { videos: videos.length, aiScored: videos.length - fallbackCount, heuristic: fallbackCount });
  return results.map(({ score, reason }) => ({
    matchScore: score,
    matchReason: reason,
    isBelowThreshold: score < config.matchThreshold,
  }));
}

/**
 * One Gemini call for a batch of videos. Returns an array aligned with `videos`;
 * entries are null where the model gave no usable score.
 */
async function scoreBatchWithAI(videos, productAnalysis, productImage, attempt = 1) {
  const thumbnails = await Promise.all(videos.map((v) => (v.thumbnailUrl ? fetchImage(v.thumbnailUrl) : null)));
  const attrs = productAnalysis.attributes || {};

  const parts = [{
    text: `You are ranking short-form videos for how well they showcase a specific product.

PRODUCT
- Type: ${attrs.productType || 'unspecified'}
- Brand: ${attrs.brand || 'unspecified'}
- Colors: ${(attrs.colors || []).join(', ') || 'unspecified'}
- Patterns/prints: ${(attrs.patterns || []).join(', ') || 'unspecified'}
- Material: ${attrs.material || 'unspecified'}
- Shape/fit: ${attrs.shape || 'unspecified'}
- Key features: ${(attrs.keyFeatures || []).join(', ') || 'unspecified'}
${productImage ? '- The first image below is the reference product photo.' : ''}

For each video you get its caption and, when available, its thumbnail. Captions may be in any language.
Score 0-100:
- 80-100: clearly features this exact product or a near-identical one (type, color, style, brand all fit)
- 50-79: features the same kind of product, with some differences (color, style, brand)
- 20-49: loosely related (product only in passing, accessory, adjacent category)
- 0-19: unrelated (e.g. ads for novels, services, other product categories)

Respond with a JSON array only: [{"index": <video index>, "score": <0-100>, "reason": "<max 15 words, cite what you saw>"}]`,
  }];

  if (productImage) parts.push({ inlineData: productImage });

  videos.forEach((video, i) => {
    const caption = (video.caption || '').replace(/\s+/g, ' ').slice(0, 500) || '(no caption)';
    parts.push({ text: `VIDEO ${i} [${video.platform}] by ${video.author || 'unknown'}\nCaption: ${caption}${thumbnails[i] ? '' : '\n(no thumbnail)'}` });
    if (thumbnails[i]) parts.push({ inlineData: thumbnails[i] });
  });

  try {
    const response = await callGemini(
      {
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingLevel: 'low' },
        },
      },
      90000
    );

    const text = (response.data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    const parsed = JSON.parse(text);
    const out = new Array(videos.length).fill(null);

    for (const row of Array.isArray(parsed) ? parsed : []) {
      const idx = Number(row.index);
      const score = Number(row.score);
      if (!Number.isInteger(idx) || idx < 0 || idx >= videos.length || !Number.isFinite(score)) continue;
      out[idx] = {
        score: Math.round(Math.min(100, Math.max(0, score))),
        reason: `AI: ${String(row.reason || 'scored by Gemini').trim()}`,
      };
    }
    return out;
  } catch (error) {
    const status = error.response?.status;
    if ((status === 429 || status === 503) && attempt < 3) {
      const waitMs = 8000 * attempt;
      logger.warn('AI scoring: rate limited, retrying', { status, waitMs });
      await new Promise((r) => setTimeout(r, waitMs));
      return scoreBatchWithAI(videos, productAnalysis, productImage, attempt + 1);
    }
    logger.warn('AI scoring: batch failed, using heuristic', { status, error: error.message });
    return new Array(videos.length).fill(null);
  }
}

/**
 * Text-only fallback: caption attribute match (60%) + search-query overlap (40%).
 */
function scoreVideoHeuristic(video, productAnalysis) {
  const caption = scoreCaptionRelevance(video.caption, productAnalysis);
  const keyword = scoreKeywordMatch(video.caption, productAnalysis);
  const score = Math.round(caption.score * 0.6 + keyword.score * 0.4);
  const reason = ['Keyword match', caption.reason, keyword.reason].filter(Boolean).join('; ');
  return { score: Math.min(100, Math.max(0, score)), reason };
}

function buildAnalysisPrompt(title, description) {
  return `Analyze this product image and extract structured visual attributes. If no image is provided, analyze based on the product information.

Product title: "${title || 'Unknown'}"
Product description: "${description || 'None provided'}"

Return a JSON object with these exact fields:
{
  "productType": "category of the product (e.g., t-shirt, chocolate bar, sneakers)",
  "colors": ["list of dominant colors"],
  "patterns": ["prints, graphics, patterns visible"],
  "brand": "brand name if visible or identifiable",
  "textOnProduct": ["any text/words visible on the product"],
  "material": "material type if identifiable (cotton, leather, plastic, etc.)",
  "shape": "general shape/form description",
  "keyFeatures": ["distinctive visual features that make this product unique"],
  "searchQueries": ["5-8 optimized search queries for finding videos of this exact product on social media"],
  "hashtags": ["10-15 relevant Instagram hashtags for finding videos of this product"],
  "metaAdKeywords": ["5-8 keywords optimized for Meta Ad Library search"]
}`;
}

// Gemini answers "unknown" / "N/A" when it can't identify a value; treat those as empty.
const PLACEHOLDER_VALUE = /^(unknown|n\/?a|none|null|generic|unbranded|not visible|not identifiable)$/i;
const cleanValue = (v) => (typeof v === 'string' && !PLACEHOLDER_VALUE.test(v.trim()) ? v.trim() : '');
const cleanList = (list) => (Array.isArray(list) ? list.map(cleanValue).filter(Boolean) : []);
const withoutPlaceholders = (list) => cleanList(list).filter((v) => !/\bunknown\b/i.test(v));

function normalizeAnalysis(analysis, productTitle) {
  return {
    attributes: {
      productType: cleanValue(analysis.productType) || productTitle,
      colors: cleanList(analysis.colors),
      patterns: cleanList(analysis.patterns),
      brand: cleanValue(analysis.brand),
      textOnProduct: analysis.textOnProduct || [],
      material: analysis.material || '',
      shape: analysis.shape || '',
      keyFeatures: analysis.keyFeatures || [],
    },
    searchQueries: withoutPlaceholders(analysis.searchQueries).length ? withoutPlaceholders(analysis.searchQueries) : [productTitle],
    hashtags: withoutPlaceholders(analysis.hashtags),
    metaAdKeywords: withoutPlaceholders(analysis.metaAdKeywords).length ? withoutPlaceholders(analysis.metaAdKeywords) : [productTitle],
  };
}

function generateFallbackAnalysis(title = '', description = '') {
  // Without a title there is nothing to build queries from (e.g. a photo-only search whose
  // vision call failed); return an empty analysis so the pipeline can stop instead of
  // searching generic terms like "review" or "unboxing".
  if (!title.trim()) {
    return {
      attributes: { productType: '', colors: [], patterns: [], brand: '', textOnProduct: [], material: '', shape: '', keyFeatures: [] },
      searchQueries: [],
      hashtags: [],
      metaAdKeywords: [],
      isFallback: true,
    };
  }

  const combined = `${title} ${description}`.toLowerCase();
  const words = title.split(/\s+/).filter((w) => w.length > 2);

  const COLOR_LIST = ['black', 'white', 'grey', 'gray', 'charcoal', 'navy', 'blue', 'red', 'green', 'olive', 'brown', 'beige', 'cream', 'pink', 'purple', 'yellow', 'gold', 'silver', 'dark'];
  const MATERIAL_LIST = ['cotton', 'denim', 'leather', 'wool', 'linen', 'polyester', 'silk', 'mesh', 'fleece', 'canvas', 'metal', 'plastic', 'glass', 'ceramic'];
  const PATTERN_LIST = ['graphic', 'oversized', 'minimalist', 'vintage', 'striped', 'floral', 'plaid', 'printed', 'solid', 'embroidered', 'tie-dye', 'camo'];
  const BRAND_LIST = ['nike', 'adidas', 'gymshark', 'zara', 'apple', 'sony', 'samsung', 'gucci', 'h&m', "levi's", 'lululemon', 'under armour', 'puma', 'dior', 'prada', 'supreme', 'stussy'];

  const foundColors = COLOR_LIST.filter((c) => combined.includes(c));
  const foundMaterials = MATERIAL_LIST.filter((m) => combined.includes(m));
  const foundPatterns = PATTERN_LIST.filter((p) => combined.includes(p));
  const foundBrand = BRAND_LIST.find((b) => combined.includes(b)) || '';

  return {
    attributes: {
      productType: title.split(/\s+/).slice(0, 3).join(' '),
      colors: foundColors,
      patterns: foundPatterns,
      brand: foundBrand ? foundBrand.charAt(0).toUpperCase() + foundBrand.slice(1) : '',
      textOnProduct: words.slice(0, 3),
      material: foundMaterials[0] || '',
      shape: '',
      keyFeatures: words.slice(0, 5),
    },
    searchQueries: [
      title,
      `${title} review`,
      `${title} unboxing`,
      `best ${title}`,
      `${title} haul`,
    ],
    hashtags: words.map((w) => `#${w.replace(/[^a-z0-9]/gi, '')}`).filter((h) => h.length > 1),
    metaAdKeywords: [title, ...words.slice(0, 4)],
    isFallback: true,
  };
}

function scoreCaptionRelevance(caption, analysis) {
  if (!caption) return { score: 20, reason: 'No caption available' };

  const captionLower = caption.toLowerCase();
  const attrs = analysis.attributes || {};
  let matches = 0;
  let total = 0;
  const matched = [];

  // Check product type
  if (attrs.productType) {
    total++;
    if (captionLower.includes(attrs.productType.toLowerCase())) {
      matches++;
      matched.push('product type');
    }
  }

  // Check colors
  for (const color of (attrs.colors || [])) {
    total++;
    if (captionLower.includes(color.toLowerCase())) {
      matches++;
      matched.push(color);
    }
  }

  // Check brand
  if (attrs.brand) {
    total++;
    if (captionLower.includes(attrs.brand.toLowerCase())) {
      matches += 2;
      total++;
      matched.push(`brand: ${attrs.brand}`);
    }
  }

  // Check key features
  for (const feature of (attrs.keyFeatures || []).slice(0, 5)) {
    total++;
    if (captionLower.includes(feature.toLowerCase())) {
      matches++;
      matched.push(feature);
    }
  }

  const score = total > 0 ? Math.round((matches / total) * 100) : 20;
  const reason = matched.length > 0
    ? `Caption matches: ${matched.join(', ')}`
    : 'No attribute matches in caption';

  return { score: Math.min(100, score), reason };
}

function scoreKeywordMatch(caption, analysis) {
  if (!caption) return { score: 15, reason: '' };

  const captionLower = caption.toLowerCase();
  const queries = analysis.searchQueries || [];
  let bestMatch = 0;

  for (const query of queries) {
    const queryWords = query.toLowerCase().split(/\s+/);
    const matchCount = queryWords.filter((w) => captionLower.includes(w)).length;
    const ratio = queryWords.length > 0 ? matchCount / queryWords.length : 0;
    bestMatch = Math.max(bestMatch, ratio);
  }

  const score = Math.round(bestMatch * 100);
  return {
    score,
    reason: score > 50 ? 'Strong keyword overlap with search queries' : '',
  };
}

async function fetchImage(imageUrl) {
  if (typeof imageUrl === 'string' && imageUrl.startsWith('data:')) {
    return parseImageDataUrl(imageUrl);
  }
  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      maxContentLength: 5 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
    const mimeType = String(response.headers['content-type'] || '').split(';')[0];
    if (!mimeType.startsWith('image/')) return null;
    return { mimeType, data: Buffer.from(response.data).toString('base64') };
  } catch (error) {
    logger.debug('Image fetch failed', { url: imageUrl, error: error.message });
    return null;
  }
}

module.exports = { analyzeProductImage, scoreVideos, scoreVideoHeuristic, scoreCaptionRelevance };
