// Uploaded product photos arrive as data URLs (the browser downsizes them before upload).
const DATA_URL_PATTERN = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** Returns { mimeType, data } for a valid image data URL, or null. */
function parseImageDataUrl(value) {
  if (typeof value !== 'string') return null;
  const match = DATA_URL_PATTERN.exec(value);
  if (!match) return null;
  const bytes = Math.floor((match[2].length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) return null;
  return { mimeType: match[1], data: match[2] };
}

const isDataUrl = (value) => typeof value === 'string' && value.startsWith('data:');

/** Short, log-safe description of an image reference (never logs base64 payloads). */
const describeImage = (value) => (isDataUrl(value) ? `[uploaded image, ${value.length} chars]` : value);

module.exports = { parseImageDataUrl, isDataUrl, describeImage, MAX_IMAGE_BYTES };
