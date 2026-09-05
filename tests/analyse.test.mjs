import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse, normalizeUrl } from '../src/analyse.mjs';

const ROOT = 'https://example.com/';

function page(overrides = {}) {
  return {
    status: 200,
    finalUrl: overrides.url ?? ROOT,
    redirectChain: [],
    depth: 0,
    inboundFrom: [],
    outboundLinks: [],
    error: null,
    blockedByRobots: false,
    fetched: true,
    ...overrides,
  };
}

test('orphan: a sitemap URL the crawl never discovered', () => {
  const findings = analyse({
    root: ROOT,
    pages: {
      [ROOT]: page(),
    },
    sitemapUrls: [ROOT, 'https://example.com/orphan'],
  });
  assert.deepEqual(findings.orphans, ['https://example.com/orphan']);
});

test('unlisted: crawled and live, but absent from the sitemap', () => {
  const findings = analyse({
    root: ROOT,
    pages: {
      [ROOT]: page({ outboundLinks: ['https://example.com/secret'] }),
      'https://example.com/secret': page({ inboundFrom: [ROOT] }),
    },
    sitemapUrls: [ROOT],
  });
  assert.deepEqual(findings.unlisted, ['https://example.com/secret']);
});

test('a 404/500 fetched page is a broken internal link, with its linkers listed', () => {
  const findings = analyse({
    root: ROOT,
    pages: {
      [ROOT]: page({ outboundLinks: ['https://example.com/missing'] }),
      'https://example.com/missing': page({ status: 404, inboundFrom: [ROOT], depth: 1 }),
    },
    sitemapUrls: [ROOT],
  });
  assert.equal(findings.brokenLinks.length, 1);
  assert.equal(findings.brokenLinks[0].url, 'https://example.com/missing');
  assert.equal(findings.brokenLinks[0].status, 404);
  assert.deepEqual(findings.brokenLinks[0].linkedFrom, [ROOT]);
});

test('a fetch error also counts as a broken internal link', () => {
  const findings = analyse({
    root: ROOT,
    pages: {
      [ROOT]: page({ outboundLinks: ['https://example.com/down'] }),
      'https://example.com/down': page({
        status: null,
        error: 'ECONNRESET',
        inboundFrom: [ROOT],
        depth: 1,
      }),
    },
    sitemapUrls: [ROOT],
  });
  assert.equal(findings.brokenLinks.length, 1);
  assert.equal(findings.brokenLinks[0].error, 'ECONNRESET');
});

test('a page with a recorded redirect chain is reported with its hop count', () => {
  const findings = analyse({
    root: ROOT,
    pages: {
      [ROOT]: page({ outboundLinks: ['https://example.com/old'] }),
      'https://example.com/old': page({
        status: 301,
        finalUrl: 'https://example.com/new',
        redirectChain: ['https://example.com/mid', 'https://example.com/new'],
        inboundFrom: [ROOT],
        depth: 1,
      }),
    },
    sitemapUrls: [ROOT],
  });
  assert.equal(findings.redirectChains.length, 1);
  assert.equal(findings.redirectChains[0].length, 2);
  assert.equal(findings.redirectChains[0].finalUrl, 'https://example.com/new');
});

test('depth: only pages strictly deeper than maxDepth are flagged', () => {
  const findings = analyse({
    root: ROOT,
    pages: {
      [ROOT]: page({ depth: 0 }),
      'https://example.com/at-limit': page({ depth: 3 }),
      'https://example.com/too-deep': page({ depth: 4 }),
    },
    sitemapUrls: [ROOT],
    maxDepth: 3,
  });
  assert.deepEqual(findings.deepPages.map((p) => p.url), ['https://example.com/too-deep']);
});

test('dead sitemap entries: observed via the crawl itself', () => {
  const findings = analyse({
    root: ROOT,
    pages: {
      [ROOT]: page(),
      'https://example.com/broken': page({ status: 500, inboundFrom: [ROOT], depth: 1 }),
    },
    sitemapUrls: [ROOT, 'https://example.com/broken'],
  });
  assert.equal(findings.deadSitemapEntries.length, 1);
  assert.equal(findings.deadSitemapEntries[0].url, 'https://example.com/broken');
  assert.equal(findings.deadSitemapEntries[0].status, 500);
  assert.equal(findings.deadSitemapEntries[0].source, 'crawl');
});

test('dead sitemap entries: observed via a separate verification probe', () => {
  const findings = analyse({
    root: ROOT,
    pages: { [ROOT]: page() },
    sitemapUrls: [ROOT, 'https://example.com/gone'],
    sitemapStatus: { 'https://example.com/gone': { status: 410 } },
  });
  assert.equal(findings.deadSitemapEntries.length, 1);
  assert.equal(findings.deadSitemapEntries[0].status, 410);
  assert.equal(findings.deadSitemapEntries[0].source, 'probe');
  // it is also, correctly, an orphan: the crawl never reached it either.
  assert.deepEqual(findings.orphans, ['https://example.com/gone']);
});

test('a sitemap URL never observed by crawl or probe is reported as unobserved, never guessed as dead', () => {
  const findings = analyse({
    root: ROOT,
    pages: { [ROOT]: page() },
    sitemapUrls: [ROOT, 'https://example.com/unknown-status'],
    // no sitemapStatus entry for /unknown-status at all
  });
  assert.equal(findings.deadSitemapEntries.length, 0, 'never printed a count it did not observe');
  assert.deepEqual(findings.unobservedSitemapEntries, ['https://example.com/unknown-status']);
  assert.deepEqual(findings.orphans, ['https://example.com/unknown-status']);
});

test('a page blocked by this tool\'s own robots.txt compliance is reported separately, not as an orphan or dead entry', () => {
  const findings = analyse({
    root: ROOT,
    pages: {
      [ROOT]: page({ outboundLinks: ['https://example.com/private'] }),
      'https://example.com/private': page({
        status: null,
        fetched: false,
        blockedByRobots: true,
        inboundFrom: [ROOT],
        depth: 1,
      }),
    },
    sitemapUrls: [ROOT, 'https://example.com/private'],
  });
  assert.deepEqual(
    findings.robotsBlocked.map((p) => p.url),
    ['https://example.com/private'],
  );
  assert.deepEqual(findings.orphans, [], 'discovered via a link, so it is reachable, not orphaned');
  assert.equal(findings.deadSitemapEntries.length, 0, 'never fetched, so no status was ever observed');
});

test('truncated and maxPages pass through unchanged for the report to warn with', () => {
  const findings = analyse({
    root: ROOT,
    pages: { [ROOT]: page() },
    sitemapUrls: [ROOT],
    truncated: true,
    maxPages: 50,
  });
  assert.equal(findings.truncated, true);
  assert.equal(findings.maxPages, 50);
});

test('findingsCount sums every category', () => {
  const findings = analyse({
    root: ROOT,
    pages: {
      [ROOT]: page({ outboundLinks: ['https://example.com/missing'] }),
      'https://example.com/missing': page({ status: 404, inboundFrom: [ROOT], depth: 1 }),
    },
    sitemapUrls: [ROOT, 'https://example.com/orphan'],
  });
  assert.equal(findings.counts.findingsCount, findings.orphans.length + findings.brokenLinks.length);
});

test('normalizeUrl strips only the fragment, nothing else', () => {
  assert.equal(normalizeUrl('https://example.com/a#section'), 'https://example.com/a');
  assert.equal(normalizeUrl('https://example.com/a'), 'https://example.com/a');
});

test('URLs that differ only by a trailing slash are honestly treated as different pages (documented limitation)', () => {
  const findings = analyse({
    root: ROOT,
    pages: {
      [ROOT]: page({ outboundLinks: ['https://example.com/about'] }),
      'https://example.com/about': page({ inboundFrom: [ROOT], depth: 1 }),
    },
    sitemapUrls: [ROOT, 'https://example.com/about/'], // note the trailing slash
  });
  // The tool does not guess these are the same URL, so both symptoms show up:
  assert.deepEqual(findings.orphans, ['https://example.com/about/']);
  assert.deepEqual(findings.unlisted, ['https://example.com/about']);
});
