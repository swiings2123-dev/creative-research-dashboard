const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config');
const logger = require('../utils/logger');
const { validateUrl } = require('../utils/urlValidator');
const NodeCache = require('node-cache');

// Cache product data for 1 hour to avoid re-fetching
const productCache = new NodeCache({ stdTTL: 3600 });

/**
 * Resolve a product from either a URL or a keyword query.
 * If URL: scrapes the page for title, description, image, price.
 * If keyword: returns the keyword as the product title.
 */
async function resolveProduct(input) {
  const isUrl = /^https?:\/\//i.test(input);

  if (!isUrl) {
    logger.info('Product resolver: keyword input', { query: input });
    return {
      inputType: 'keyword',
      title: input,
      description: '',
      imageUrl: null,
      source: 'keyword',
    };
  }

  // Check cache
  const cached = productCache.get(input);
  if (cached) {
    logger.info('Product resolver: cache hit', { url: input });
    return cached;
  }

  // Validate URL for SSRF
  const validation = await validateUrl(input);
  if (!validation.valid) {
    throw new Error(`Invalid URL: ${validation.reason}`);
  }

  logger.info('Product resolver: fetching URL', { url: input });

  try {
    const response = await axios.get(input, {
      timeout: config.productFetchTimeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      maxRedirects: 5,
    });

    const $ = cheerio.load(response.data);
    const product = extractProductData($, input);

    // Cache it
    productCache.set(input, product);
    logger.info('Product resolver: extracted', { title: product.title });

    return product;
  } catch (error) {
    logger.error('Product resolver: fetch failed', { url: input, error: error.message });
    throw new Error(`Could not fetch product page: ${error.message}`);
  }
}

/**
 * Extract product data from parsed HTML using multiple strategies.
 */
function extractProductData($, url) {
  let title = '';
  let description = '';
  let imageUrl = '';
  let price = '';

  // Strategy 1: JSON-LD structured data (best quality)
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      const product = findProductInLD(data);
      if (product) {
        title = title || product.name || '';
        description = description || product.description || '';
        imageUrl = imageUrl || extractImage(product.image) || '';
        if (product.offers) {
          const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
          price = price || offers.price || '';
        }
      }
    } catch (e) {}
  });

  // Strategy 2: Open Graph meta tags
  title = title || $('meta[property="og:title"]').attr('content') || '';
  description = description || $('meta[property="og:description"]').attr('content') || '';
  imageUrl = imageUrl || $('meta[property="og:image"]').attr('content') || '';

  // Strategy 3: Twitter card meta tags
  title = title || $('meta[name="twitter:title"]').attr('content') || '';
  description = description || $('meta[name="twitter:description"]').attr('content') || '';
  imageUrl = imageUrl || $('meta[name="twitter:image"]').attr('content') || '';

  // Strategy 4: Standard HTML tags
  title = title || $('h1').first().text().trim() || $('title').text().trim() || '';
  description = description || $('meta[name="description"]').attr('content') || '';

  // Strategy 5: Common e-commerce selectors
  if (!imageUrl) {
    imageUrl = $('[data-zoom-image]').attr('data-zoom-image')
      || $('[id*="product"] img, [class*="product"] img, [class*="gallery"] img').first().attr('src')
      || $('main img').first().attr('src')
      || '';
  }

  // Make image URL absolute
  if (imageUrl && !imageUrl.startsWith('http')) {
    try {
      imageUrl = new URL(imageUrl, url).href;
    } catch (e) {}
  }

  return {
    inputType: 'url',
    title: title.slice(0, 500),
    description: description.slice(0, 2000),
    imageUrl,
    price,
    source: url,
  };
}

function findProductInLD(data) {
  if (!data) return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findProductInLD(item);
      if (found) return found;
    }
    return null;
  }
  if (data['@type'] === 'Product' || data['@type'] === 'IndividualProduct') {
    return data;
  }
  if (data['@graph']) {
    return findProductInLD(data['@graph']);
  }
  return null;
}

function extractImage(image) {
  if (!image) return '';
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) return image[0] || '';
  if (image.url) return image.url;
  return '';
}

module.exports = { resolveProduct };
