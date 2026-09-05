import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, allowAllRobots } from '../src/robots.mjs';

test('missing robots.txt means everything is allowed', () => {
  const r = allowAllRobots();
  assert.equal(r.isAllowed('/anything'), true);
  assert.equal(r.isAllowed('/private/secret'), true);
});

test('empty robots.txt body means everything is allowed', () => {
  const r = parseRobots('', 'OrphanageBot');
  assert.equal(r.isAllowed('/x'), true);
});

test('a simple Disallow blocks its prefix and nothing else', () => {
  const r = parseRobots(
    ['User-agent: *', 'Disallow: /private/'].join('\n'),
    'OrphanageBot',
  );
  assert.equal(r.isAllowed('/private/page'), false);
  assert.equal(r.isAllowed('/public/page'), true);
});

test('an empty Disallow value disallows nothing', () => {
  const r = parseRobots(['User-agent: *', 'Disallow:'].join('\n'), 'OrphanageBot');
  assert.equal(r.isAllowed('/anything'), true);
});

test('wildcard "*" and end-anchor "$" behave like the Google robots.txt extension', () => {
  const r = parseRobots(['User-agent: *', 'Disallow: /*.pdf$'].join('\n'), 'OrphanageBot');
  assert.equal(r.isAllowed('/a/b.pdf'), false, 'exact .pdf at the end is blocked');
  assert.equal(r.isAllowed('/a/b.pdf?x=1'), true, '$ anchors the true end; a query string escapes it');
  assert.equal(r.isAllowed('/a/b.pdfx'), true, 'not a .pdf at the end');
});

test('Allow overrides Disallow when it is the more specific (longer) match', () => {
  const r = parseRobots(
    ['User-agent: *', 'Disallow: /', 'Allow: /public/'].join('\n'),
    'OrphanageBot',
  );
  assert.equal(r.isAllowed('/public/page'), true, 'the longer Allow rule wins');
  assert.equal(r.isAllowed('/other'), false, 'falls back to the blanket Disallow');
});

test('on an exact-length tie, Allow wins over Disallow', () => {
  const r = parseRobots(
    ['User-agent: *', 'Disallow: /page', 'Allow: /page'].join('\n'),
    'OrphanageBot',
  );
  assert.equal(r.isAllowed('/page'), true);
});

test('a group naming this crawler\'s own token is used instead of the wildcard group', () => {
  const text = [
    'User-agent: OrphanageBot',
    'Disallow: /a',
    '',
    'User-agent: *',
    'Allow: /',
  ].join('\n');
  const r = parseRobots(text, 'OrphanageBot/1.0 (+https://example.com/bot)');
  assert.equal(r.isAllowed('/a'), false, 'the specific group applies, not merged with the wildcard');
  assert.equal(r.isAllowed('/a/nested'), false);
  assert.equal(r.isAllowed('/b'), true, 'no rule in the specific group covers this path');
});

test('consecutive User-agent lines with no rules between them share one group', () => {
  const text = ['User-agent: bot1', 'User-agent: bot2', 'Disallow: /x'].join('\n');
  const forBot1 = parseRobots(text, 'bot1');
  const forBot2 = parseRobots(text, 'bot2');
  assert.equal(forBot1.isAllowed('/x'), false);
  assert.equal(forBot2.isAllowed('/x'), false);
});

test('Sitemap: directives are captured for the caller to use', () => {
  const text = [
    'User-agent: *',
    'Disallow:',
    'Sitemap: https://example.com/sitemap.xml',
    'Sitemap: https://example.com/sitemap-news.xml',
  ].join('\n');
  const r = parseRobots(text, 'OrphanageBot');
  assert.deepEqual(r.sitemaps, [
    'https://example.com/sitemap.xml',
    'https://example.com/sitemap-news.xml',
  ]);
});

test('comments and blank lines are ignored', () => {
  const text = ['# a comment', '', 'User-agent: *  # inline comment is stripped', 'Disallow: /x'].join(
    '\n',
  );
  const r = parseRobots(text, 'OrphanageBot');
  assert.equal(r.isAllowed('/x'), false);
  assert.equal(r.isAllowed('/y'), true);
});
