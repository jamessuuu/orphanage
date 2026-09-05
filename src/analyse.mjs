// analyse.mjs — pure functions turning a crawl graph + sitemap into findings.
//
// Nothing in this file does I/O. It operates entirely on plain data (the
// shape crawl.mjs and sitemap.mjs already return), which is what makes it
// testable with small hand-written fixture graphs instead of a network.
//
// URL comparison is intentionally shallow: two URLs are "the same page" only
// if they are identical once the fragment is stripped. This tool does not
// guess that "/about" and "/about/" or "http://" and "https://" are
// equivalent — that would be inventing behaviour the site never declared.
// See README Limitations.

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return String(url).trim();
  }
}
const normalize = normalizeUrl;

/**
 * @param {object} input
 * @param {string} input.root - the crawl's root URL (for the report header).
 * @param {Record<string, object>} input.pages - crawl().pages (plain object).
 * @param {string[]} input.sitemapUrls - URLs declared in the sitemap.
 * @param {Record<string, {status:number|null,finalUrl?:string,error?:string|null}|number>} [input.sitemapStatus]
 *   - observed live status for sitemap URLs that the crawl itself never
 *     reached (from a separate, rate-limited verification pass). Optional;
 *     omitted entries are honestly reported as "never observed" rather than
 *     guessed at.
 * @param {number} [input.maxDepth] - click-depth threshold for the "hard to
 *   discover" finding. Default 3.
 * @param {boolean} [input.truncated] - whether the crawl hit its page cap.
 * @param {number} [input.maxPages] - the cap that was configured, for the
 *   report's truncation notice.
 */
export function analyse(input) {
  const {
    root,
    pages = {},
    sitemapUrls = [],
    sitemapStatus = {},
    maxDepth = 3,
    truncated = false,
    maxPages = null,
  } = input;

  const pageEntries = Object.entries(pages).map(([url, rec]) => ({
    url: normalize(url),
    status: rec.status ?? null,
    finalUrl: rec.finalUrl ?? url,
    redirectChain: rec.redirectChain ?? [],
    depth: rec.depth ?? 0,
    inboundFrom: rec.inboundFrom ?? [],
    outboundLinks: rec.outboundLinks ?? [],
    error: rec.error ?? null,
    blockedByRobots: !!rec.blockedByRobots,
    fetched: !!rec.fetched,
    canonical: rec.canonical ?? null,
    contentType: rec.contentType ?? null,
    isHtml: rec.isHtml !== false,
  }));
  const byUrl = new Map(pageEntries.map((p) => [p.url, p]));

  const crawledSet = new Set(pageEntries.map((p) => p.url)); // discovered via link-following, any status
  const fetched200 = new Set(pageEntries.filter((p) => p.fetched && p.status === 200).map((p) => p.url));
  const sitemapSet = new Set(sitemapUrls.map(normalize));

  // --- Orphans: in the sitemap, never discovered by following links. ------
  const orphans = [...sitemapSet]
    .filter((u) => !crawledSet.has(u))
    .sort();

  // --- Unlisted: reached and live via crawling, absent from the sitemap. --
  // A page whose rel=canonical points elsewhere is asking to be consolidated,
  // so it is not missing from the sitemap; it is deliberately not a separate
  // entry. Splitting these out rather than counting them turned 40 findings
  // into 0 real ones on the first real site tested (agentjames, 2026-09-05),
  // where every /console?c=... permalink canonicalises to /console. Reporting
  // those as unlisted would bury any genuine finding under query-string noise.
  const canonicalisedElsewhere = [...fetched200]
    .filter((u) => !sitemapSet.has(u))
    .filter((u) => { const p = byUrl.get(u); return p && p.canonical && normalize(p.canonical) !== u; })
    .map((u) => ({ url: u, canonical: byUrl.get(u).canonical }))
    .sort((a, b) => a.url.localeCompare(b.url));
  const canonicalisedSet = new Set(canonicalisedElsewhere.map((x) => x.url));
  // Non-HTML resources are split out for the same reason canonicalised
  // pages are. A sitemap lists indexable pages. Reporting llms.txt,
  // agent.json or resume.md as "missing from your sitemap" would be advice
  // that makes the site worse, and wrong advice is the one thing this tool
  // must never produce. A PDF is a genuine judgement call, so these are
  // reported with their content type rather than silently dropped.
  const notInSitemap = [...fetched200].filter((u) => !sitemapSet.has(u) && !canonicalisedSet.has(u));
  const unlistedNonHtml = notInSitemap
    .filter((u) => { const p = byUrl.get(u); return p && p.isHtml === false; })
    .map((u) => ({ url: u, contentType: byUrl.get(u).contentType }))
    .sort((x, y) => x.url.localeCompare(y.url));
  const nonHtmlSet = new Set(unlistedNonHtml.map((x) => x.url));
  const unlisted = notInSitemap.filter((u) => !nonHtmlSet.has(u)).sort();

  // --- Broken internal links: a fetched page that errored or 4xx/5xx'd. ---
  const brokenLinks = pageEntries
    .filter((p) => p.fetched && (p.error || (typeof p.status === 'number' && p.status >= 400)))
    .map((p) => ({
      url: p.url,
      status: p.status,
      error: p.error,
      linkedFrom: [...p.inboundFrom].sort(),
    }))
    .sort((a, b) => a.url.localeCompare(b.url));

  // --- Redirect chains: an internal link target that itself redirects. ----
  const redirectChains = pageEntries
    .filter((p) => p.redirectChain.length > 0)
    .map((p) => ({
      url: p.url,
      chain: p.redirectChain,
      finalUrl: p.finalUrl,
      length: p.redirectChain.length,
      linkedFrom: [...p.inboundFrom].sort(),
    }))
    .sort((a, b) => b.length - a.length || a.url.localeCompare(b.url));

  // --- Depth: reached, but more than maxDepth clicks from the root. -------
  const deepPages = pageEntries
    .filter((p) => Number.isFinite(p.depth) && p.depth > maxDepth)
    .map((p) => ({ url: p.url, depth: p.depth }))
    .sort((a, b) => b.depth - a.depth || a.url.localeCompare(b.url));

  // --- Pages our own robots.txt compliance kept us from fetching. ---------
  const robotsBlocked = pageEntries
    .filter((p) => p.blockedByRobots)
    .map((p) => ({ url: p.url, linkedFrom: [...p.inboundFrom].sort() }))
    .sort((a, b) => a.url.localeCompare(b.url));
  const robotsBlockedSet = new Set(robotsBlocked.map((p) => p.url));

  // --- Dead sitemap entries: an observed, non-200 status. Never guessed. --
  const deadSitemapEntries = [];
  const unobservedSitemapEntries = [];
  for (const su of sitemapSet) {
    if (robotsBlockedSet.has(su)) continue; // excluded by our own compliance, not "dead"
    const rec = byUrl.get(su);
    if (rec && rec.fetched) {
      const status = rec.status ?? 'error';
      if (status !== 200) deadSitemapEntries.push({ url: su, status, source: 'crawl' });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(sitemapStatus, su)) {
      const probed = sitemapStatus[su];
      const status = probed && typeof probed === 'object' ? probed.status ?? 'error' : probed;
      if (status !== 200) deadSitemapEntries.push({ url: su, status, source: 'probe' });
      continue;
    }
    unobservedSitemapEntries.push(su);
  }
  deadSitemapEntries.sort((a, b) => a.url.localeCompare(b.url));
  unobservedSitemapEntries.sort();

  const findingsCount =
    orphans.length +
    unlisted.length +
    brokenLinks.length +
    redirectChains.length +
    deepPages.length +
    deadSitemapEntries.length;

  return {
    root,
    truncated,
    maxPages,
    maxDepth,
    counts: {
      pagesDiscovered: crawledSet.size,
      pagesFetched: pageEntries.filter((p) => p.fetched).length,
      sitemapUrlCount: sitemapSet.size,
      findingsCount,
    },
    orphans,
    unlisted,
    canonicalisedElsewhere,
    unlistedNonHtml,
    brokenLinks,
    redirectChains,
    deepPages,
    deadSitemapEntries,
    robotsBlocked,
    unobservedSitemapEntries,
  };
}
