// crawl.mjs — a polite, bounded, same-origin link crawler.
//
// Scope reminder: this module does link-graph discovery only. It does not do
// per-user-agent bot probing, does not render JavaScript, and always crawls
// with one honest, identifying User-Agent string. That is a sibling tool's
// job.
//
// Everything that touches the network is injected (fetchImpl, sleepImpl) so
// tests can drive this module with a fixture graph and a fake clock — see
// tests/crawl.test.mjs. There is no hidden global fetch call in the hot path;
// the only default is at the edges (DEFAULT_FETCH / DEFAULT_SLEEP), which
// production code (bin/orphanage.mjs) picks up implicitly by not overriding
// them.

import { parseRobots, allowAllRobots } from './robots.mjs';

export const DEFAULT_USER_AGENT = 'OrphanageBot/1.0 (+https://github.com/jamessuuu/orphanage)';
export const DEFAULT_MAX_PAGES = 500;
export const DEFAULT_DELAY_MS = 1000;
const DEFAULT_MAX_REDIRECTS = 10;

async function DEFAULT_SLEEP(ms) {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

function DEFAULT_FETCH(url, init) {
  return fetch(url, init);
}

function stripFragment(url) {
  const u = new URL(url);
  u.hash = '';
  return u.toString();
}

// Extract same-origin <a href="..."> targets from raw HTML. This is a
// regex-based scan, not an HTML parser — it finds ordinary anchor tags in
// served markup. It cannot and does not try to see links injected by
// client-side JavaScript; see the README Limitations section.
/**
 * The page's declared canonical, absolute, or null.
 *
 * A page that points its canonical somewhere else is asking search engines to
 * consolidate it, so it is NOT a page missing from the sitemap. Without this,
 * every query-string variant of one route is reported as a separate unlisted
 * page. Measured on agentjames.vercel.app 2026-09-05: 40 'unlisted' findings,
 * almost all of them /console?c=... permalinks that all declare
 * rel=canonical -> /console. That is 40 pieces of noise hiding any real finding.
 */
export function extractCanonical(html, baseUrl) {
  const m = String(html ?? '').match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i);
  if (!m) return null;
  const href = m[0].match(/href=["']([^"']+)["']/i);
  if (!href) return null;
  try { return new URL(href[1], baseUrl).toString(); } catch { return null; }
}

export function extractLinks(html, baseUrl, origin) {
  const hrefRe = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi;
  const out = new Set();
  let m;
  while ((m = hrefRe.exec(html))) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!raw) continue;
    if (/^(javascript:|mailto:|tel:|#)/i.test(raw)) continue;
    let abs;
    try {
      abs = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
    if (abs.origin !== origin) continue;
    abs.hash = '';
    out.add(abs.toString());
  }
  return [...out];
}

function looksLikeHtml(res) {
  const ct = typeof res.headers?.get === 'function' ? res.headers.get('content-type') : null;
  if (!ct) return true; // unknown content-type: be permissive, try to parse it
  return /text\/html|application\/xhtml/i.test(ct);
}

/**
 * Crawl a site starting at rootUrl, following only same-origin <a href>
 * links, respecting robots.txt, rate-limited and capped.
 *
 * @returns {{
 *   root: string,
 *   userAgent: string,
 *   maxPages: number,
 *   delayMs: number,
 *   truncated: boolean,
 *   fetchedCount: number,
 *   robots: { status: string, sitemaps: string[] },
 *   pages: Record<string, {
 *     status: number|null,
 *     finalUrl: string,
 *     redirectChain: string[],
 *     depth: number,
 *     inboundFrom: string[],
 *     outboundLinks: string[],
 *     error: string|null,
 *     blockedByRobots: boolean,
 *     fetched: boolean,
 *   }>
 * }>}
 */
export async function crawl(options) {
  const {
    rootUrl,
    fetchImpl = DEFAULT_FETCH,
    sleepImpl = DEFAULT_SLEEP,
    userAgent = DEFAULT_USER_AGENT,
    maxPages = DEFAULT_MAX_PAGES,
    delayMs = DEFAULT_DELAY_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    respectRobots = true,
  } = options;

  const root = new URL(rootUrl);
  root.hash = '';
  const origin = root.origin;
  const rootStr = root.toString();

  let firstRequestMade = false;
  async function throttledFetch(url, init) {
    if (firstRequestMade) await sleepImpl(delayMs);
    firstRequestMade = true;
    return fetchImpl(url, init);
  }

  // --- robots.txt -----------------------------------------------------
  let robots = allowAllRobots();
  let robotsStatus = 'disabled';
  if (respectRobots) {
    try {
      const res = await throttledFetch(`${origin}/robots.txt`, {
        headers: { 'User-Agent': userAgent },
        redirect: 'manual',
      });
      if (res.status === 200) {
        const text = await res.text();
        robots = parseRobots(text, userAgent);
        robotsStatus = 'fetched';
      } else if (res.status === 404) {
        robotsStatus = 'not-found (allow all)';
      } else {
        robotsStatus = `http-${res.status} (allow all)`;
      }
    } catch (err) {
      robotsStatus = `fetch-error: ${err.message} (allow all)`;
    }
  }

  // --- crawl state ------------------------------------------------------
  const pages = new Map();
  function getOrCreate(url, depth) {
    let rec = pages.get(url);
    if (!rec) {
      rec = {
        status: null,
        finalUrl: url,
        redirectChain: [],
        depth,
        inboundFrom: new Set(),
        outboundLinks: new Set(),
        error: null,
        blockedByRobots: false,
        fetched: false,
      };
      pages.set(url, rec);
    } else if (depth < rec.depth) {
      rec.depth = depth;
    }
    return rec;
  }

  getOrCreate(rootStr, 0);
  const queue = [rootStr];
  const enqueued = new Set([rootStr]);
  let fetchedCount = 0;
  let truncated = false;

  while (queue.length) {
    const url = queue.shift();
    const record = pages.get(url);

    if (fetchedCount >= maxPages) {
      truncated = true;
      continue; // leave remaining discovered URLs as known-but-uncrawled
    }

    const u = new URL(url);
    if (!robots.isAllowed(u.pathname + u.search)) {
      record.blockedByRobots = true;
      continue;
    }

    fetchedCount++;
    record.fetched = true;

    let currentUrl = url;
    let firstStatus = null;
    let finalRes = null;
    let fetchError = null;
    const chain = [];

    try {
      for (let hop = 0; ; hop++) {
        const res = await throttledFetch(currentUrl, {
          headers: { 'User-Agent': userAgent },
          redirect: 'manual',
        });
        if (firstStatus === null) firstStatus = res.status;
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc) {
            finalRes = res;
            break;
          }
          if (hop >= maxRedirects) {
            fetchError = 'too-many-redirects';
            finalRes = res;
            break;
          }
          currentUrl = new URL(loc, currentUrl).toString();
          chain.push(currentUrl);
          continue;
        }
        finalRes = res;
        break;
      }
    } catch (err) {
      fetchError = err.message;
    }

    record.status = firstStatus;
    record.finalUrl = currentUrl;
    record.redirectChain = chain;
    record.error = fetchError;

    if (!fetchError && finalRes) {
      // Recorded so the analysis can tell a page from a machine endpoint.
      // A sitemap lists indexable PAGES; telling someone to add llms.txt or
      // agent.json to theirs would be wrong advice.
      record.contentType = (finalRes.headers && typeof finalRes.headers.get === 'function' ? finalRes.headers.get('content-type') : null) ?? null;
      record.isHtml = looksLikeHtml(finalRes);
    }

    if (!fetchError && finalRes && finalRes.status === 200 && looksLikeHtml(finalRes)) {
      const body = await finalRes.text();
      record.canonical = extractCanonical(body, currentUrl);
      record.selfCanonical = record.canonical === null || record.canonical === currentUrl;
      const links = extractLinks(body, currentUrl, origin);
      for (const link of links) {
        record.outboundLinks.add(link);
        const child = getOrCreate(link, record.depth + 1);
        child.inboundFrom.add(url);
        if (!enqueued.has(link)) {
          enqueued.add(link);
          queue.push(link);
        }
      }
    }
  }

  if (queue.length > 0) truncated = true; // anything left un-dequeued due to the cap

  const plainPages = {};
  for (const [url, rec] of pages) {
    plainPages[url] = {
      status: rec.status,
      finalUrl: rec.finalUrl,
      redirectChain: rec.redirectChain,
      depth: rec.depth,
      inboundFrom: [...rec.inboundFrom],
      outboundLinks: [...rec.outboundLinks],
      error: rec.error,
      blockedByRobots: rec.blockedByRobots,
      fetched: rec.fetched,
      canonical: rec.canonical ?? null,
      contentType: rec.contentType ?? null,
      isHtml: rec.isHtml ?? false,
    };
  }

  return {
    root: rootStr,
    userAgent,
    maxPages,
    delayMs,
    truncated,
    fetchedCount,
    robots: { status: robotsStatus, sitemaps: robots.sitemaps },
    pages: plainPages,
  };
}

/**
 * Verify the live HTTP status of a specific list of URLs (used to find out
 * whether an orphaned sitemap entry is at least alive, or actually dead).
 * Rate-limited and injectable exactly like crawl().
 *
 * @returns {Record<string, { status: number|null, finalUrl: string, error: string|null }>}
 */
export async function verifyUrls(urls, options) {
  const {
    fetchImpl = DEFAULT_FETCH,
    sleepImpl = DEFAULT_SLEEP,
    userAgent = DEFAULT_USER_AGENT,
    delayMs = DEFAULT_DELAY_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
  } = options;

  let firstRequestMade = false;
  async function throttledFetch(url, init) {
    if (firstRequestMade) await sleepImpl(delayMs);
    firstRequestMade = true;
    return fetchImpl(url, init);
  }

  const result = {};
  for (const url of urls) {
    let currentUrl = url;
    let firstStatus = null;
    let error = null;
    try {
      for (let hop = 0; ; hop++) {
        const res = await throttledFetch(currentUrl, {
          headers: { 'User-Agent': userAgent },
          redirect: 'manual',
        });
        if (firstStatus === null) firstStatus = res.status;
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc || hop >= maxRedirects) break;
          currentUrl = new URL(loc, currentUrl).toString();
          continue;
        }
        break;
      }
    } catch (err) {
      error = err.message;
    }
    result[url] = { status: firstStatus, finalUrl: currentUrl, error };
  }
  return result;
}

export { stripFragment };
