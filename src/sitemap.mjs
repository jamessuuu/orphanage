// sitemap.mjs — fetch and parse a site's declared sitemap(s).
//
// Handles the two common real-world shapes: a plain <urlset> and a
// <sitemapindex> that points at child sitemaps. Gzipped sitemaps are
// supported because Node's built-in zlib makes that trivial and it costs no
// extra dependency. Anything genuinely non-trivial (a sitemap so large it
// would be irresponsible to hold in memory) is skipped with a stated reason
// rather than silently mis-parsed or pretended away.
//
// No dependency on crawl.mjs's throttling internals — this module carries
// its own small rate limiter so it can be used and tested standalone.

import { gunzipSync } from 'node:zlib';
import { DEFAULT_USER_AGENT, DEFAULT_DELAY_MS } from './crawl.mjs';

const MAX_CHILD_SITEMAPS_DEFAULT = 50;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50MB sanity cap

function DEFAULT_FETCH(url, init) {
  return fetch(url, init);
}
async function DEFAULT_SLEEP(ms) {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function extractLocs(xml) {
  const out = [];
  const re = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const val = decodeXmlEntities(m[1]).trim();
    if (val) out.push(val);
  }
  return out;
}

function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(xml);
}

function looksGzipped(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * @param {object} options
 * @param {string} options.rootUrl - site root, used to derive origin + the
 *   default /sitemap.xml location.
 * @param {string[]} [options.candidateUrls] - sitemap URLs to try first
 *   (e.g. Sitemap: lines discovered in robots.txt). Falls back to
 *   `${origin}/sitemap.xml` if omitted or all candidates fail.
 * @param {number} [options.maxChildSitemaps] - cap on how many child
 *   sitemaps a sitemapindex will be expanded into.
 */
export async function fetchSitemap(options) {
  const {
    rootUrl,
    candidateUrls,
    fetchImpl = DEFAULT_FETCH,
    sleepImpl = DEFAULT_SLEEP,
    userAgent = DEFAULT_USER_AGENT,
    delayMs = DEFAULT_DELAY_MS,
    maxChildSitemaps = MAX_CHILD_SITEMAPS_DEFAULT,
  } = options;

  const origin = new URL(rootUrl).origin;
  const initial =
    candidateUrls && candidateUrls.length ? candidateUrls : [`${origin}/sitemap.xml`];

  let firstRequestMade = false;
  async function throttledFetch(url) {
    if (firstRequestMade) await sleepImpl(delayMs);
    firstRequestMade = true;
    return fetchImpl(url, { headers: { 'User-Agent': userAgent }, redirect: 'follow' });
  }

  const urls = new Set();
  const sitemapsFetched = [];
  const errors = [];
  const skipped = [];
  let truncated = false;

  async function fetchOneSitemap(url) {
    let res;
    try {
      res = await throttledFetch(url);
    } catch (err) {
      errors.push({ url, reason: `fetch failed: ${err.message}` });
      return null;
    }
    if (res.status !== 200) {
      errors.push({ url, reason: `HTTP ${res.status}` });
      return null;
    }
    let buf;
    try {
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      errors.push({ url, reason: `could not read body: ${err.message}` });
      return null;
    }
    const contentEncoding = res.headers?.get?.('content-encoding') || '';
    const gzipHinted = /gzip/i.test(contentEncoding) || /\.gz$/i.test(url) || looksGzipped(buf);
    if (gzipHinted) {
      try {
        buf = gunzipSync(buf);
      } catch (err) {
        errors.push({ url, reason: `gzip decode failed: ${err.message}` });
        return null;
      }
    }
    if (buf.length > MAX_UNCOMPRESSED_BYTES) {
      skipped.push({
        url,
        reason: `sitemap is ${Math.round(buf.length / 1024 / 1024)}MB uncompressed, over the ${
          MAX_UNCOMPRESSED_BYTES / 1024 / 1024
        }MB safety cap — skipped rather than risk loading it fully into memory`,
      });
      return null;
    }
    sitemapsFetched.push(url);
    return buf.toString('utf8');
  }

  const toVisit = [...initial];
  const visited = new Set();
  let childSitemapCount = 0;

  while (toVisit.length) {
    const url = toVisit.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    const xml = await fetchOneSitemap(url);
    if (xml === null) continue;

    if (isSitemapIndex(xml)) {
      const children = extractLocs(xml);
      for (const child of children) {
        if (childSitemapCount >= maxChildSitemaps) {
          truncated = true;
          break;
        }
        if (!visited.has(child)) {
          toVisit.push(child);
          childSitemapCount++;
        }
      }
    } else {
      for (const loc of extractLocs(xml)) urls.add(loc);
    }
  }

  return {
    urls: [...urls],
    sitemapsFetched,
    errors,
    skipped,
    truncated,
  };
}

export { decodeXmlEntities, extractLocs, isSitemapIndex };
