import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawl, extractLinks, verifyUrls } from '../src/crawl.mjs';
import { createFakeFetch, createFakeSleep } from './helpers/fake-fetch.mjs';

const ORIGIN = 'http://site.test';

function noRobots() {
  return { '/robots.txt': { status: 404, body: 'not found' } };
}

test('extractLinks: same-origin only, resolves relative hrefs, strips fragments', () => {
  const html = `
    <a href="/a">a</a>
    <a href="b">relative b</a>
    <a href='/c'>single-quoted</a>
    <a href="/d#section">has a fragment</a>
    <a href="https://other.test/x">off-origin</a>
    <a href="mailto:x@example.com">mailto</a>
    <a href="tel:+1234">tel</a>
    <a href="javascript:void(0)">js</a>
    <a href="#top">hash-only</a>
  `;
  const links = extractLinks(html, `${ORIGIN}/dir/page`, ORIGIN);
  assert.deepEqual(
    new Set(links),
    new Set([`${ORIGIN}/a`, `${ORIGIN}/dir/b`, `${ORIGIN}/c`, `${ORIGIN}/d`]),
  );
});

test('crawl: follows same-origin links breadth-first and records inbound edges and depth', async () => {
  const routes = {
    ...noRobots(),
    '/': { status: 200, body: '<a href="/a">a</a><a href="/b">b</a>' },
    '/a': { status: 200, body: '<a href="/b">b</a>' },
    '/b': { status: 200, body: '' },
  };
  const result = await crawl({
    rootUrl: `${ORIGIN}/`,
    fetchImpl: createFakeFetch(routes),
    sleepImpl: createFakeSleep([]),
    maxPages: 100,
    delayMs: 1000,
  });

  assert.equal(result.truncated, false);
  assert.equal(result.fetchedCount, 3);
  assert.equal(result.pages[`${ORIGIN}/`].depth, 0);
  assert.equal(result.pages[`${ORIGIN}/a`].depth, 1);
  assert.equal(result.pages[`${ORIGIN}/b`].depth, 1);
  assert.deepEqual(
    new Set(result.pages[`${ORIGIN}/b`].inboundFrom),
    new Set([`${ORIGIN}/`, `${ORIGIN}/a`]),
  );
});

test('crawl: never follows an off-origin link', async () => {
  const routes = {
    ...noRobots(),
    '/': { status: 200, body: '<a href="https://other.test/x">off-origin</a>' },
  };
  const result = await crawl({
    rootUrl: `${ORIGIN}/`,
    fetchImpl: createFakeFetch(routes),
    sleepImpl: createFakeSleep([]),
  });
  assert.equal(Object.keys(result.pages).length, 1);
  assert.ok(!('https://other.test/x' in result.pages));
});

test('crawl: respects the page cap, marks the result truncated, and leaves the overflow undiscovered-but-known', async () => {
  const routes = {
    ...noRobots(),
    '/': { status: 200, body: '<a href="/a">a</a>' },
    '/a': { status: 200, body: '<a href="/b">b</a>' },
    '/b': { status: 200, body: '<a href="/c">c</a>' },
    '/c': { status: 200, body: '' },
  };
  const result = await crawl({
    rootUrl: `${ORIGIN}/`,
    fetchImpl: createFakeFetch(routes),
    sleepImpl: createFakeSleep([]),
    maxPages: 2,
    delayMs: 0,
  });

  assert.equal(result.fetchedCount, 2, 'never fetches more than the configured cap');
  assert.equal(result.truncated, true);
  assert.equal(result.pages[`${ORIGIN}/`].fetched, true);
  assert.equal(result.pages[`${ORIGIN}/a`].fetched, true);
  assert.equal(result.pages[`${ORIGIN}/b`].fetched, false, 'discovered via a link, but the cap was hit first');
  assert.equal(result.pages[`${ORIGIN}/b`].status, null);
});

test('crawl: sleeps between every request except the very first, using the configured delay', async () => {
  const routes = {
    ...noRobots(),
    '/': { status: 200, body: '<a href="/a">a</a>' },
    '/a': { status: 200, body: '' },
  };
  const sleeps = [];
  await crawl({
    rootUrl: `${ORIGIN}/`,
    fetchImpl: createFakeFetch(routes),
    sleepImpl: createFakeSleep(sleeps),
    delayMs: 1234,
  });
  // requests made: robots.txt, "/", "/a" = 3 requests => 2 sleeps, each 1234ms
  assert.deepEqual(sleeps, [1234, 1234]);
});

test('crawl: a Disallow in robots.txt is obeyed and reported, not silently skipped', async () => {
  const routes = {
    '/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /private/\n' },
    '/': { status: 200, body: '<a href="/private/page">private</a>' },
    '/private/page': { status: 200, body: 'should never be fetched' },
  };
  const calls = [];
  const result = await crawl({
    rootUrl: `${ORIGIN}/`,
    fetchImpl: createFakeFetch(routes, { calls }),
    sleepImpl: createFakeSleep([]),
  });
  assert.equal(result.pages[`${ORIGIN}/private/page`].blockedByRobots, true);
  assert.equal(result.pages[`${ORIGIN}/private/page`].fetched, false);
  assert.ok(
    !calls.includes(`${ORIGIN}/private/page`),
    'the disallowed URL was never actually requested',
  );
});

test('crawl: follows a redirect chain, records it, and keeps crawling from the destination', async () => {
  const routes = {
    ...noRobots(),
    '/': { status: 200, body: '<a href="/old">old</a>' },
    '/old': { status: 301, location: '/new' },
    '/new': { status: 200, body: '<a href="/other">other</a>' },
    '/other': { status: 200, body: '' },
  };
  const result = await crawl({
    rootUrl: `${ORIGIN}/`,
    fetchImpl: createFakeFetch(routes),
    sleepImpl: createFakeSleep([]),
  });
  const old = result.pages[`${ORIGIN}/old`];
  assert.equal(old.status, 301);
  assert.equal(old.finalUrl, `${ORIGIN}/new`);
  assert.deepEqual(old.redirectChain, [`${ORIGIN}/new`]);
  assert.ok(
    `${ORIGIN}/other` in result.pages,
    'crawling continued past the redirect into the destination page\'s links',
  );
  assert.deepEqual(result.pages[`${ORIGIN}/other`].inboundFrom, [`${ORIGIN}/old`]);
});

test('crawl: a network error is recorded on the page, not thrown out of the whole crawl', async () => {
  const routes = {
    ...noRobots(),
    '/': { status: 200, body: '<a href="/down">down</a>' },
  };
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname === '/down') throw new Error('ECONNRESET');
    return createFakeFetch(routes)(url, init);
  };
  const result = await crawl({
    rootUrl: `${ORIGIN}/`,
    fetchImpl,
    sleepImpl: createFakeSleep([]),
  });
  assert.equal(result.pages[`${ORIGIN}/down`].error, 'ECONNRESET');
  assert.equal(result.pages[`${ORIGIN}/down`].status, null);
  assert.equal(result.pages[`${ORIGIN}/down`].fetched, true, 'a fetch was attempted');
});

test('verifyUrls: probes a fixed list of URLs and reports their observed status, rate-limited', async () => {
  const routes = {
    '/gone': { status: 410, body: '' },
    '/ok': { status: 200, body: '' },
  };
  const sleeps = [];
  const result = await verifyUrls([`${ORIGIN}/gone`, `${ORIGIN}/ok`], {
    fetchImpl: createFakeFetch(routes),
    sleepImpl: createFakeSleep(sleeps),
    delayMs: 500,
  });
  assert.equal(result[`${ORIGIN}/gone`].status, 410);
  assert.equal(result[`${ORIGIN}/ok`].status, 200);
  assert.deepEqual(sleeps, [500]); // 2 requests => 1 sleep
});
