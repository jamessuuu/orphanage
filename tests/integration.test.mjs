// integration.test.mjs — runs the whole pipeline (crawl -> sitemap -> verify
// -> analyse -> report -> check) against the fixture site, entirely through
// an injected fake fetch. No sockets, no DNS — see fixtures/site/server.mjs
// for the real-HTTP version of this same fixture, used for the one-off
// manual "generate a real report" demonstration instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crawl, verifyUrls } from '../src/crawl.mjs';
import { fetchSitemap } from '../src/sitemap.mjs';
import { analyse, normalizeUrl } from '../src/analyse.mjs';
import { renderReport, check } from '../src/report.mjs';
import { pages, robotsTxtFor, sitemapXmlFor, EXPECTED } from '../fixtures/site/pages.mjs';
import { createFakeFetch, createFakeSleep } from './helpers/fake-fetch.mjs';

const ORIGIN = 'http://fixture.test';

function buildRoutes() {
  return {
    ...pages,
    '/robots.txt': { status: 200, body: robotsTxtFor(ORIGIN) },
    '/sitemap.xml': { status: 200, body: sitemapXmlFor(ORIGIN) },
  };
}

test('end to end: the fixture site produces exactly the expected findings', async () => {
  const fetchImpl = createFakeFetch(buildRoutes());
  const sleepImpl = createFakeSleep([]);

  const crawlResult = await crawl({ rootUrl: `${ORIGIN}/`, fetchImpl, sleepImpl, delayMs: 0 });
  assert.equal(crawlResult.truncated, false, 'the whole fixture site fits well under the default cap');

  const sitemapResult = await fetchSitemap({
    rootUrl: `${ORIGIN}/`,
    candidateUrls: crawlResult.robots.sitemaps,
    fetchImpl,
    sleepImpl,
  });
  assert.equal(sitemapResult.urls.length, EXPECTED.sitemapUrlCount);
  // robots.txt's Sitemap: line was actually used to find it.
  assert.deepEqual(sitemapResult.sitemapsFetched, [`${ORIGIN}/sitemap.xml`]);

  const discovered = new Set(Object.keys(crawlResult.pages).map(normalizeUrl));
  const toVerify = sitemapResult.urls.map(normalizeUrl).filter((u) => !discovered.has(u));
  const sitemapStatus = await verifyUrls(toVerify, { fetchImpl, sleepImpl, delayMs: 0 });

  const findings = analyse({
    root: crawlResult.root,
    pages: crawlResult.pages,
    sitemapUrls: sitemapResult.urls,
    sitemapStatus,
    maxDepth: 3,
    truncated: crawlResult.truncated,
    maxPages: crawlResult.maxPages,
  });

  const pathsOf = (urls) => urls.map((u) => new URL(u).pathname).sort();

  assert.deepEqual(pathsOf(findings.orphans), [...EXPECTED.orphans].sort());
  assert.deepEqual(pathsOf(findings.unlisted), EXPECTED.unlisted);
  assert.deepEqual(pathsOf(findings.brokenLinks.map((b) => b.url)), EXPECTED.brokenLinks);
  assert.deepEqual(pathsOf(findings.redirectChains.map((r) => r.url)), EXPECTED.redirectChains);
  assert.deepEqual(pathsOf(findings.deepPages.map((d) => d.url)), EXPECTED.deepPages);
  assert.deepEqual(pathsOf(findings.deadSitemapEntries.map((d) => d.url)), EXPECTED.deadSitemapEntries);
  assert.deepEqual(pathsOf(findings.robotsBlocked.map((r) => r.url)), EXPECTED.robotsBlocked);

  // the report renders and is a clean, self-contained, checkable document
  const html = renderReport(findings, {
    userAgent: crawlResult.userAgent,
    robotsStatus: crawlResult.robots.status,
    delayMs: crawlResult.delayMs,
    sitemapSources: sitemapResult.sitemapsFetched,
    sitemapErrors: sitemapResult.errors,
    sitemapSkipped: sitemapResult.skipped,
  });
  const dir = mkdtempSync(join(tmpdir(), 'orphanage-integration-'));
  const file = join(dir, 'report.html');
  writeFileSync(file, html, 'utf8');
  assert.equal(check(file), 0, 'the generated report must pass --check');

  // the dead sitemap entry (/gone) is annotated as separately probed, since
  // the crawl itself never reached it.
  const gone = findings.deadSitemapEntries.find((d) => new URL(d.url).pathname === '/gone');
  assert.equal(gone.source, 'probe');
  assert.equal(gone.status, 410);
});
