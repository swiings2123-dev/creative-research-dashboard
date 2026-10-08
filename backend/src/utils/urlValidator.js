const url = require('url');
const dns = require('dns');
const { promisify } = require('util');

const dnsResolve = promisify(dns.resolve);

// Private/internal IP ranges to block (SSRF protection)
const BLOCKED_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^fc00:/i,
  /^fe80:/i,
  /^::1$/,
  /^localhost$/i,
];

function isBlockedHost(hostname) {
  return BLOCKED_RANGES.some((re) => re.test(hostname));
}

async function validateUrl(inputUrl) {
  try {
    const parsed = new URL(inputUrl);

    // Only allow http and https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, reason: 'Only HTTP and HTTPS URLs are allowed' };
    }

    // Block internal hostnames
    if (isBlockedHost(parsed.hostname)) {
      return { valid: false, reason: 'Internal/private URLs are not allowed' };
    }

    // Resolve DNS and check resulting IPs
    try {
      const addresses = await dnsResolve(parsed.hostname);
      for (const addr of addresses) {
        if (isBlockedHost(addr)) {
          return { valid: false, reason: 'URL resolves to a private/internal address' };
        }
      }
    } catch (e) {
      // DNS resolution failed — could be an IP-based URL, allow it if not blocked
      if (isBlockedHost(parsed.hostname)) {
        return { valid: false, reason: 'Internal/private URLs are not allowed' };
      }
    }

    return { valid: true, url: parsed.href };
  } catch (e) {
    return { valid: false, reason: 'Invalid URL format' };
  }
}

module.exports = { validateUrl, isBlockedHost };
