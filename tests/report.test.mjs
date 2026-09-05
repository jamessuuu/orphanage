import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderReport, check } from '../src/report.mjs';

function baseFindings() {
  return {
    root: 'https://example.com/',
    truncated: false,
    maxPages: 500,
    maxDepth: 3,
    counts: { pagesDiscovered: 3, pagesFetched: 3, sitemapUrlCount: 2, findingsCount: 2 },
    orphans: ['https://example.com/orphan'],
    unlisted: [],
    brokenLinks: [{ url: 'https://example.com/missing', status: 404, error: null, linkedFrom: ['https://example.com/'] }],
    redirectChains: [],
    deepPages: [],
    deadSitemapEntries: [],
    robotsBlocked: [],
    unobservedSitemapEntries: [],
  };
}

function baseMeta() {
  return {
    userAgent: 'OrphanageBot/1.0',
    robotsStatus: 'fetched',
    delayMs: 1000,
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function writeTemp(html) {
  const dir = mkdtempSync(join(tmpdir(), 'orphanage-report-'));
  const file = join(dir, 'report.html');
  writeFileSync(file, html, 'utf8');
  return file;
}

test('renderReport produces a clean report that passes --check', () => {
  const html = renderReport(baseFindings(), baseMeta());
  assert.equal(check(writeTemp(html)), 0);
});

test('every check rule has a fixture that makes it fail', () => {
  const clean = renderReport(baseFindings(), baseMeta());

  const cases = {
    'injected <script>': clean.replace('</head>', '<script>alert(1)</script></head>'),
    'remote <img src>': clean.replace(
      '<main class="wrap">',
      '<main class="wrap"><img src="https://cdn.example.com/x.png">',
    ),
    'remote stylesheet <link>': clean.replace(
      '</head>',
      '<link rel="stylesheet" href="https://fonts.example.com/x.css"></head>',
    ),
    'CSS remote @import': clean.replace('<style>', '<style>@import url(https://fonts.example.com/x.css);'),
    'missing viewport meta': clean.replace(
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '',
    ),
    'missing print stylesheet': clean.replace(/@media print\{[\s\S]*?\n\}/, ''),
    'missing doctype': clean.replace('<!doctype html>\n', ''),
    'missing overflow-wrap: anywhere': clean.replace(/overflow-wrap:\s*anywhere/gi, 'overflow-wrap:normal'),
    'a collapsed <details>': clean.replace('<details open>', '<details>'),
    'unbalanced <details>': clean.replace('</details>', ''),
    'unbalanced <table>': clean.replace('</table>', ''),
  };

  for (const [name, brokenHtml] of Object.entries(cases)) {
    assert.notEqual(brokenHtml, clean, `${name}: the transformation must actually change the file`);
    const result = check(writeTemp(brokenHtml));
    assert.equal(result, 1, `--check should FAIL for: ${name}`);
  }
});

test('an empty finding category renders "None" rather than an empty table', () => {
  const html = renderReport(baseFindings(), baseMeta());
  assert.match(html, /None\. Every page reached by crawling is declared in the sitemap\./);
});

test('the truncation notice only appears when the crawl was actually truncated', () => {
  const clean = renderReport(baseFindings(), baseMeta());
  assert.doesNotMatch(clean, /Crawl was truncated/);

  const truncatedFindings = { ...baseFindings(), truncated: true, maxPages: 50 };
  const truncatedHtml = renderReport(truncatedFindings, baseMeta());
  assert.match(truncatedHtml, /Crawl was truncated at 50 pages/);
});

test('robots-blocked pages are shown as excluded by compliance, not counted as broken or orphaned', () => {
  const findings = {
    ...baseFindings(),
    robotsBlocked: [{ url: 'https://example.com/private', linkedFrom: ['https://example.com/'] }],
  };
  const html = renderReport(findings, baseMeta());
  assert.ok(html.includes("excluded by this tool's own"));
  assert.ok(html.includes('robots.txt compliance'));
  assert.match(html, /example\.com\/private/);
});
