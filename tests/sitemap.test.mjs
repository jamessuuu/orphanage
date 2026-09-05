import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { fetchSitemap, decodeXmlEntities, extractLocs, isSitemapIndex } from '../src/sitemap.mjs';
import { createFakeFetch, createFakeSleep } from './helpers/fake-fetch.mjs';

const ORIGIN = 'http://site.test';

test('decodeXmlEntities handles the standard five plus numeric entities', () => {
  assert.equal(decodeXmlEntities('a &amp; b'), 'a & b');
  assert.equal(decodeXmlEntities('&lt;tag&gt;'), '<tag>');
  assert.equal(decodeXmlEntities('&quot;q&quot; &apos;a&apos;'), '"q" \'a\'');
  assert.equal(decodeXmlEntities('&#65;&#x42;'), 'AB');
});

test('extractLocs pulls every <loc> value, isSitemapIndex detects the index root tag', () => {
  const urlset = '<urlset><url><loc>https://a.test/1</loc></url><url><loc>https://a.test/2</loc></url></urlset>';
  assert.deepEqual(extractLocs(urlset), ['https://a.test/1', 'https://a.test/2']);
  assert.equal(isSitemapIndex(urlset), false);

  const index = '<sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap></sitemapindex>';
  assert.equal(isSitemapIndex(index), true);
});

test('fetchSitemap: parses a plain urlset at the default location', async () => {
  const routes = {
    '/sitemap.xml': {
      status: 200,
      body: `<urlset><url><loc>${ORIGIN}/</loc></url><url><loc>${ORIGIN}/about</loc></url></urlset>`,
      headers: { 'content-type': 'application/xml' },
    },
  };
  const result = await fetchSitemap({
    rootUrl: `${ORIGIN}/`,
    fetchImpl: createFakeFetch(routes),
    sleepImpl: createFakeSleep([]),
  });
  assert.deepEqual(result.urls.sort(), [`${ORIGIN}/`, `${ORIGIN}/about`]);
  assert.deepEqual(result.sitemapsFetched, [`${ORIGIN}/sitemap.xml`]);
  assert.equal(result.errors.length, 0);
});

test('fetchSitemap: expands a sitemapindex into its child sitemaps and merges the URLs', async () => {
  const routes = {
    '/sitemap.xml': {
      status: 200,
      body: `<sitemapindex><sitemap><loc>${ORIGIN}/sitemap-1.xml</loc></sitemap><sitemap><loc>${ORIGIN}/sitemap-2.xml</loc></sitemap></sitemapindex>`,
    },
    '/sitemap-1.xml': { status: 200, body: `<urlset><url><loc>${ORIGIN}/a</loc></url></urlset>` },
    '/sitemap-2.xml': { status: 200, body: `<urlset><url><loc>${ORIGIN}/b</loc></url></urlset>` },
  };
  const result = await fetchSitemap({
    rootUrl: `${ORIGIN}/`,
    fetchImpl: createFakeFetch(routes),
    sleepImpl: createFakeSleep([]),
  });
  assert.deepEqual(result.urls.sort(), [`${ORIGIN}/a`, `${ORIGIN}/b`]);
  assert.deepEqual(
    result.sitemapsFetched.sort(),
    [`${ORIGIN}/sitemap-1.xml`, `${ORIGIN}/sitemap-2.xml`, `${ORIGIN}/sitemap.xml`].sort(),
  );
});

test('fetchSitemap: transparently decompresses a gzipped sitemap (via node:zlib, no dependency)', async () => {
  const xml = `<urlset><url><loc>${ORIGIN}/gz-page</loc></url></urlset>`;
  const gz = gzipSync(Buffer.from(xml, 'utf8'));
  const routes = {
    '/sitemap.xml.gz': { status: 200, body: gz, headers: { 'content-type': 'application/gzip' } },
  };
  const result = await fetchSitemap({
    rootUrl: `${ORIGIN}/`,
    candidateUrls: [`${ORIGIN}/sitemap.xml.gz`],
    fetchImpl: createFakeFetch(routes),
    sleepImpl: createFakeSleep([]),
  });
  assert.deepEqual(result.urls, [`${ORIGIN}/gz-page`]);
});

test('fetchSitemap: an oversized sitemap is skipped honestly rather than risked in memory', async () => {
  const huge = Buffer.alloc(51 * 1024 * 1024, 0x20); // 51MB of spaces, over the 50MB cap
  const routes = { '/sitemap.xml': { status: 200, body: huge } };
  const result = await fetchSitemap({
    rootUrl: `${ORIGIN}/`,
    fetchImpl: createFakeFetch(routes),
    sleepImpl: createFakeSleep([]),
  });
  assert.deepEqual(result.urls, []);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /50MB safety cap/);
});

test('fetchSitemap: a failing candidate is recorded as an error, a succeeding one is still merged', async () => {
  const routes = {
    '/sitemap-news.xml': { status: 404, body: 'not found' },
    '/sitemap.xml': { status: 200, body: `<urlset><url><loc>${ORIGIN}/only-page</loc></url></urlset>` },
  };
  const result = await fetchSitemap({
    rootUrl: `${ORIGIN}/`,
    candidateUrls: [`${ORIGIN}/sitemap-news.xml`, `${ORIGIN}/sitemap.xml`],
    fetchImpl: createFakeFetch(routes),
    sleepImpl: createFakeSleep([]),
  });
  assert.deepEqual(result.urls, [`${ORIGIN}/only-page`]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].url, `${ORIGIN}/sitemap-news.xml`);
  assert.match(result.errors[0].reason, /404/);
});

test('fetchSitemap: entities in <loc> are decoded', async () => {
  const routes = {
    '/sitemap.xml': {
      status: 200,
      body: `<urlset><url><loc>${ORIGIN}/search?a=1&amp;b=2</loc></url></urlset>`,
    },
  };
  const result = await fetchSitemap({
    rootUrl: `${ORIGIN}/`,
    fetchImpl: createFakeFetch(routes),
    sleepImpl: createFakeSleep([]),
  });
  assert.deepEqual(result.urls, [`${ORIGIN}/search?a=1&b=2`]);
});
