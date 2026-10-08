require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT) || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',
  apifyToken: process.env.APIFY_API_TOKEN,
  geminiApiKey: process.env.GEMINI_API_KEY,
  // Comma-separated fallback chain; the next model is used once one hits its daily free-tier quota.
  geminiModels: (process.env.GEMINI_MODEL || 'gemini-flash-lite-latest,gemini-3.1-flash-lite-preview,gemini-3-flash-preview')
    .split(',').map((m) => m.trim()).filter(Boolean),
  enableTiktok: process.env.ENABLE_TIKTOK === 'true',
  // Match score threshold - videos below this are marked as low confidence
  matchThreshold: 40,
  // Minimum videos per source
  minVideosPerSource: 20,
  // Timeouts
  apifyTimeoutSecs: 300,
  productFetchTimeoutMs: 15000,
};
