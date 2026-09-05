#!/usr/bin/env node
// report.mjs — render an analyse() findings object into ONE self-contained
// HTML report.
//
// Design constraints (deliberate, copied from the precedent at
// C:\Users\admin\.claude\tools\supabase-review\render-review.mjs and applied
// here for the same reasons):
//   * zero network requests — no CDN, no web fonts, no analytics, no
//     favicon fetch. The file renders identically on a plane.
//   * zero JavaScript — folding uses native <details>/<summary>.
//   * every <details> is OPEN by default — a collapsed <details> vanishes
//     from a printed PDF, and this document's tables ARE the evidence.
//   * a print stylesheet, a viewport meta tag, and overflow-wrap: anywhere
//     on every URL cell so one long URL can't push the page wider than a
//     phone (or a printed page).
//
// Usage:
//   node report.mjs --check report.html
//   node report.mjs --selftest
// (Normal rendering happens via the exported renderReport(), called from
// bin/orphanage.mjs — there is no reason to hand-author a findings.json.)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function code(s) {
  return `<code>${esc(s)}</code>`;
}

function urlList(urls) {
  if (!urls || !urls.length) return '<span class="muted">(none)</span>';
  return urls.map((u) => code(u)).join('<br>');
}

function statusBadge(status, error) {
  if (error) return `<span class="badge bad">error</span> ${esc(error)}`;
  if (status === null || status === undefined) return '<span class="badge">unknown</span>';
  const cls = status >= 500 ? 'bad' : status >= 400 ? 'bad' : status >= 300 ? 'warn' : 'ok';
  return `<span class="badge ${cls}">${esc(String(status))}</span>`;
}

function section({ id, title, count, emptyText, tableHtml }) {
  if (!count) {
    return `<h2 id="${id}">${esc(title)}</h2>\n<p class="ok-line">${esc(emptyText)}</p>`;
  }
  return `<h2 id="${id}">${esc(title)}</h2>
<details open><summary>${count} found &mdash; click to fold</summary>
${tableHtml}
</details>`;
}

function table(columns, rows) {
  return `<div class="tablewrap"><table><thead><tr>${columns
    .map((c) => `<th>${esc(c)}</th>`)
    .join('')}</tr></thead><tbody>
${rows.join('\n')}
</tbody></table></div>`;
}

/**
 * @param {object} findings - the object returned by analyse().
 * @param {object} [meta]
 * @param {string} [meta.userAgent]
 * @param {string} [meta.robotsStatus]
 * @param {number} [meta.delayMs]
 * @param {string} [meta.generatedAt] - ISO timestamp; defaults to now. Pass
 *   an explicit value in tests so output is deterministic.
 * @param {string[]} [meta.robotsSitemaps] - Sitemap: lines declared in robots.txt
 */
export function renderReport(findings, meta = {}) {
  const {
    userAgent = 'unknown',
    robotsStatus = 'unknown',
    delayMs = null,
    maxRedirects = null,
    generatedAt = new Date().toISOString(),
    sitemapSources = [],
    sitemapErrors = [],
    sitemapSkipped = [],
  } = meta;

  const {
    root,
    truncated,
    maxPages,
    maxDepth,
    counts,
    orphans,
    unlisted,
    brokenLinks,
    redirectChains,
    deepPages,
    deadSitemapEntries,
    robotsBlocked,
    unobservedSitemapEntries,
  } = findings;

  const truncationNotice = truncated
    ? `<div class="banner warn"><strong>Crawl was truncated at ${esc(
        String(maxPages),
      )} pages.</strong> Orphan and unlisted results are therefore incomplete — pages the
      crawler had not yet reached when it hit the cap cannot be told apart from pages
      that genuinely have no incoming link. Re-run with a higher <code>--max-pages</code>
      for a complete picture.</div>`
    : '';

  const unobservedNotice = unobservedSitemapEntries.length
    ? `<div class="banner"><strong>${unobservedSitemapEntries.length} sitemap URL(s) have an
      unknown live status</strong> — they were not reached while crawling and were not
      separately verified. They are listed under Orphans if unreachable, but are not
      counted as Dead Sitemap Entries because no response was ever observed for them.
      ${urlList(unobservedSitemapEntries)}</div>`
    : '';

  const robotsBlockedNotice = robotsBlocked.length
    ? `<div class="banner">
        <strong>${robotsBlocked.length} page(s) were excluded by this tool's own
        robots.txt compliance</strong>, not because they don't exist. Robots status:
        ${esc(robotsStatus)}.
        ${table(
          ['URL', 'Linked from'],
          robotsBlocked.map(
            (p) => `<tr><td>${code(p.url)}</td><td>${urlList(p.linkedFrom)}</td></tr>`,
          ),
        )}
      </div>`
    : '';

  const body = `
<h1>Orphan &amp; sitemap coherence report</h1>
<dl class="meta-head">
  <dt>Site</dt><dd>${code(root)}</dd>
  <dt>Generated</dt><dd>${esc(generatedAt)}</dd>
  <dt>User-Agent used</dt><dd>${code(userAgent)}</dd>
  <dt>robots.txt</dt><dd>${esc(robotsStatus)}</dd>
  <dt>Rate limit</dt><dd>${delayMs === null ? 'n/a' : `${esc(String(delayMs))}ms between requests`}</dd>
  <dt>Page cap</dt><dd>${esc(String(maxPages))}${truncated ? ' (hit — see notice below)' : ''}</dd>
  <dt>Depth threshold</dt><dd>&gt; ${esc(String(maxDepth))} clicks from root</dd>
  <dt>Pages discovered</dt><dd>${esc(String(counts.pagesDiscovered))}</dd>
  <dt>Pages fetched</dt><dd>${esc(String(counts.pagesFetched))}</dd>
  <dt>Sitemap URLs</dt><dd>${esc(String(counts.sitemapUrlCount))}${
    sitemapSources.length ? ` (from ${sitemapSources.map((s) => code(s)).join(', ')})` : ''
  }</dd>
</dl>

${truncationNotice}
${unobservedNotice}
${
  sitemapErrors.length
    ? `<div class="banner warn"><strong>Sitemap fetch problems:</strong><ul>${sitemapErrors
        .map((e) => `<li>${code(e.url)} &mdash; ${esc(e.reason)}</li>`)
        .join('')}</ul></div>`
    : ''
}
${
  sitemapSkipped.length
    ? `<div class="banner warn"><strong>Sitemap(s) skipped honestly rather than mis-parsed:</strong><ul>${sitemapSkipped
        .map((e) => `<li>${code(e.url)} &mdash; ${esc(e.reason)}</li>`)
        .join('')}</ul></div>`
    : ''
}

<nav class="toc"><p>Findings</p><ol>
  <li><a href="#orphans">Orphans (${orphans.length})</a></li>
  <li><a href="#unlisted">Unlisted (${unlisted.length})</a></li>
  <li><a href="#broken">Broken internal links (${brokenLinks.length})</a></li>
  <li><a href="#redirects">Redirect chains (${redirectChains.length})</a></li>
  <li><a href="#deep">Deep pages (${deepPages.length})</a></li>
  <li><a href="#dead-sitemap">Dead sitemap entries (${deadSitemapEntries.length})</a></li>
</ol></nav>

${section({
  id: 'orphans',
  title: 'Orphans — in the sitemap, unreachable by following links from the root',
  count: orphans.length,
  emptyText: 'None. Every sitemap URL was reached by following links from the root.',
  tableHtml: table(
    ['URL'],
    orphans.map((u) => `<tr><td>${code(u)}</td></tr>`),
  ),
})}

${section({
  id: 'unlisted',
  title: 'Unlisted — reachable and live, but absent from the sitemap',
  count: unlisted.length,
  emptyText: 'None. Every page reached by crawling is declared in the sitemap.',
  tableHtml: table(
    ['URL'],
    unlisted.map((u) => `<tr><td>${code(u)}</td></tr>`),
  ),
})}

${section({
  id: 'broken',
  title: 'Broken internal links — linked from somewhere, 4xx/5xx or a fetch error',
  count: brokenLinks.length,
  emptyText: 'None. Every internal link the crawler followed resolved without a client or server error.',
  tableHtml: table(
    ['URL', 'Status', 'Linked from'],
    brokenLinks.map(
      (b) =>
        `<tr><td>${code(b.url)}</td><td>${statusBadge(b.status, b.error)}</td><td>${urlList(
          b.linkedFrom,
        )}</td></tr>`,
    ),
  ),
})}

${section({
  id: 'redirects',
  title: 'Redirect chains — an internal link points at a URL that redirects',
  count: redirectChains.length,
  emptyText: 'None. Every internal link the crawler followed resolved directly with no redirect.',
  tableHtml: table(
    ['Linked URL', 'Chain', 'Hops', 'Linked from'],
    redirectChains.map(
      (r) =>
        `<tr><td>${code(r.url)}</td><td>${[r.url, ...r.chain]
          .map((u) => code(u))
          .join(' &rarr; ')}</td><td>${esc(String(r.length))}</td><td>${urlList(
          r.linkedFrom,
        )}</td></tr>`,
    ),
  ),
})}

${section({
  id: 'deep',
  title: `Deep pages — more than ${maxDepth} click(s) from the root`,
  count: deepPages.length,
  emptyText: `None. Every page reached is within ${maxDepth} click(s) of the root.`,
  tableHtml: table(
    ['URL', 'Depth (clicks from root)'],
    deepPages.map((d) => `<tr><td>${code(d.url)}</td><td>${esc(String(d.depth))}</td></tr>`),
  ),
})}

${section({
  id: 'dead-sitemap',
  title: 'Dead sitemap entries — in the sitemap, observed returning a non-200 status',
  count: deadSitemapEntries.length,
  emptyText: 'None. Every sitemap URL whose status was observed returned 200.',
  tableHtml: table(
    ['URL', 'Observed status', 'How it was observed'],
    deadSitemapEntries.map(
      (d) =>
        `<tr><td>${code(d.url)}</td><td>${statusBadge(d.status, null)}</td><td>${esc(
          d.source === 'crawl' ? 'seen while crawling' : 'separately verified',
        )}</td></tr>`,
    ),
  ),
})}

${robotsBlockedNotice}

<footer class="meta">Generated by orphanage — a link-graph and sitemap-coherence auditor.
This report reflects one crawl, one point in time, with one ordinary browser User-Agent.
It says nothing about per-crawler (GPTBot/ClaudeBot/Googlebot) access — that is a
separate tool's job. See the README's Limitations section for what this report cannot see.</footer>
`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orphan &amp; sitemap report — ${esc(root)}</title>
<meta name="robots" content="noindex,nofollow">
<style>${CSS}</style>
</head>
<body>
<main class="wrap">
${body}
</main>
</body>
</html>
`;
}

const CSS = `
:root{
  --ink:#16191d; --muted:#5b6570; --rule:#dfe3e8; --bg:#fff;
  --code-bg:#f6f7f9; --accent:#1f4b73; --ok:#0b6b3a; --warn-bg:#fff6e5; --warn-border:#e8c877;
  --bad:#a3241f; --warnc:#8a5b00;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--ink);
  font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  overflow-wrap:break-word;
}
.wrap{max-width:56rem;margin:0 auto;padding:3.5rem 1.25rem 6rem}
h1{font-size:1.65rem;line-height:1.3;margin:0 0 .35em;letter-spacing:-.01em;font-weight:650}
h2{font-size:1.1rem;margin:2.4em 0 .7em;padding-top:1.3em;border-top:1px solid var(--rule);
   letter-spacing:-.005em;font-weight:650}
h2:first-of-type{border-top:0;padding-top:0}
p{margin:0 0 1.05em}
p.ok-line{color:var(--ok)}
ul{margin:.4em 0 0;padding-left:1.3em}
li{margin:.25em 0}
code{background:var(--code-bg);border:1px solid var(--rule);
  border-radius:3px;padding:.08em .34em;font-size:.86em;
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  overflow-wrap:anywhere;word-break:break-word}
.tablewrap{overflow-x:auto;margin:0 0 1.15em}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{text-align:left;padding:.5rem .7rem;border-bottom:1px solid var(--rule);vertical-align:top;
  overflow-wrap:anywhere;word-break:break-word}
th{font-weight:640;white-space:nowrap}
.muted{color:var(--muted)}
.badge{display:inline-block;padding:.05em .5em;border-radius:3px;font-size:.82em;font-weight:640;
  background:var(--code-bg);border:1px solid var(--rule)}
.badge.ok{color:var(--ok);border-color:#bfe3cd;background:#effaf3}
.badge.warn{color:var(--warnc);border-color:var(--warn-border);background:var(--warn-bg)}
.badge.bad{color:var(--bad);border-color:#f0c4c1;background:#fdf1f0}
.banner{margin:0 0 1.4rem;padding:.9rem 1.1rem;border:1px solid var(--warn-border);
  border-radius:6px;background:var(--warn-bg);font-size:.94rem}
.banner.warn strong{color:var(--warnc)}
dl.meta-head{
  margin:1.6rem 0 0; padding:1.05rem 1.2rem; border:1px solid var(--rule);
  border-radius:6px; display:grid; grid-template-columns:max-content 1fr;
  gap:.5rem 1.15rem; font-size:.94rem;
}
dl.meta-head dt{font-weight:640;color:var(--muted);white-space:nowrap}
dl.meta-head dd{margin:0;overflow-wrap:anywhere}
@media(max-width:640px){
  dl.meta-head{grid-template-columns:1fr;gap:0}
  dl.meta-head dt{margin-top:.55rem}
  dl.meta-head dt:first-child{margin-top:0}
}
nav.toc{margin:1.6rem 0 1.6rem;padding:1rem 1.15rem;background:var(--code-bg);
  border:1px solid var(--rule);border-radius:6px;font-size:.9rem}
nav.toc p{margin:0 0 .5em;color:var(--muted);font-size:.8rem;letter-spacing:.04em;text-transform:uppercase}
nav.toc ol{margin:0;padding-left:1.2em}
nav.toc li{margin:.2em 0}
details{margin:0 0 1.15em;border:1px solid var(--rule);border-radius:6px;background:var(--code-bg)}
details>summary{
  cursor:pointer; padding:.6rem .9rem; color:var(--muted); font-size:.85rem;
  list-style:none; user-select:none;
}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"\\25B8  ";display:inline-block}
details[open]>summary::before{content:"\\25BE  "}
details .tablewrap{margin:0;border-top:1px solid var(--rule);background:var(--bg)}
footer.meta{margin-top:3.5rem;padding-top:1.2rem;border-top:1px solid var(--rule);
  color:var(--muted);font-size:.82rem}
@media (max-width:640px){
  .wrap{padding:2rem 1rem 4rem}
  h1{font-size:1.4rem}
}
@media print{
  .wrap{max-width:none;padding:0}
  nav.toc{display:none}
  details{border:0;background:none}
  details>summary{display:none}
  details>*{display:block !important}
  details .tablewrap{border-top:1px solid var(--rule)}
  h2{page-break-after:avoid}
  table{page-break-inside:avoid}
  a{color:inherit;text-decoration:none}
}
`;

// ---- --check ---------------------------------------------------------

export function check(file) {
  const html = readFileSync(file, 'utf8');
  const problems = [];
  const warn = [];

  const fetched = [
    ...[...html.matchAll(/\bsrc\s*=\s*"(https?:\/\/[^"]+)"/gi)].map((m) => m[1]),
    ...[...html.matchAll(/<link\b[^>]*\bhref\s*=\s*"(https?:\/\/[^"]+)"/gi)].map((m) => m[1]),
  ];
  if (fetched.length)
    problems.push(`remote resource fetched on load: ${[...new Set(fetched)].join(', ')}`);
  if (/@import|url\(\s*['"]?https?:/i.test(html)) problems.push('CSS pulls a remote resource');
  if (/<script\b/i.test(html)) problems.push('contains <script>; this document must run without JS');
  if (!/<meta name="viewport"[^>]*width=device-width/i.test(html))
    problems.push('no viewport meta with width=device-width (mobile will render at desktop width)');
  if (!/@media print/i.test(html)) problems.push('no print stylesheet');
  if (!/<!doctype html>/i.test(html)) problems.push('missing doctype');
  if (!/overflow-wrap:\s*anywhere/i.test(html))
    problems.push('no overflow-wrap: anywhere rule — a long URL could overflow the page on mobile/print');

  const open = (html.match(/<details\b/g) || []).length;
  const close = (html.match(/<\/details>/g) || []).length;
  if (open !== close) problems.push(`unbalanced <details>: ${open} open-tag, ${close} close-tag`);

  const collapsed = (html.match(/<details\b(?![^>]*\bopen\b)[^>]*>/g) || []).length;
  if (collapsed)
    problems.push(
      `${collapsed} collapsed <details> block(s): content is hidden on screen and lost from print`,
    );

  const po = (html.match(/<table\b/g) || []).length;
  const pc = (html.match(/<\/table>/g) || []).length;
  if (po !== pc) problems.push(`unbalanced <table>: ${po} open, ${pc} close`);

  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html)) warn.push('emoji present');
  const bytes = Buffer.byteLength(html);
  if (bytes > 5_000_000) warn.push(`large file (${Math.round(bytes / 1024)} KB)`);

  for (const p of problems) process.stdout.write(`FAIL  ${p}\n`);
  for (const w of warn) process.stdout.write(`WARN  ${w}\n`);
  if (!problems.length)
    process.stdout.write(
      `PASS  self-contained, no JS, ${open} foldable block(s) all open, print stylesheet present, ${Math.round(
        bytes / 1024,
      )} KB\n`,
    );
  return problems.length ? 1 : 0;
}

// ---- selftest ----------------------------------------------------------

function fixtureFindings() {
  return {
    root: 'https://example.com/',
    truncated: false,
    maxPages: 500,
    maxDepth: 3,
    counts: { pagesDiscovered: 4, pagesFetched: 4, sitemapUrlCount: 3, findingsCount: 4 },
    orphans: ['https://example.com/orphan'],
    unlisted: ['https://example.com/secret'],
    brokenLinks: [
      { url: 'https://example.com/missing', status: 404, error: null, linkedFrom: ['https://example.com/'] },
    ],
    redirectChains: [
      {
        url: 'https://example.com/old',
        chain: ['https://example.com/new'],
        finalUrl: 'https://example.com/new',
        length: 1,
        linkedFrom: ['https://example.com/'],
      },
    ],
    deepPages: [],
    deadSitemapEntries: [],
    robotsBlocked: [],
    unobservedSitemapEntries: [],
  };
}

function selftest() {
  const t = [];
  const ok = (name, cond) => {
    t.push(cond);
    process.stdout.write(`${cond ? 'ok  ' : 'FAIL'}  ${name}\n`);
  };

  const html = renderReport(fixtureFindings(), {
    userAgent: 'OrphanageBot/1.0',
    robotsStatus: 'fetched',
    delayMs: 1000,
    generatedAt: '2026-01-01T00:00:00.000Z',
  });

  ok('doctype present', /<!doctype html>/i.test(html));
  ok('title mentions the site', /Orphan.*example\.com/i.test(html.split('</head>')[0]));
  ok('viewport meta present', /<meta name="viewport"[^>]*width=device-width/.test(html));
  ok('print stylesheet present', /@media print/.test(html));
  ok('no script tags', !/<script/i.test(html));
  ok('no external resources', !/(?:src|href)="https?:\/\//.test(html));
  ok('overflow-wrap anywhere present', /overflow-wrap:\s*anywhere/i.test(html));
  ok('every details is open', !/<details\b(?![^>]*\bopen\b)/.test(html));
  ok('balanced details', (html.match(/<details/g) || []).length === (html.match(/<\/details>/g) || []).length);
  ok('orphan url rendered', html.includes('example.com/orphan'));
  ok('unlisted url rendered', html.includes('example.com/secret'));
  ok('broken link status rendered', /404/.test(html));
  ok('redirect chain rendered', /example\.com\/old/.test(html) && /example\.com\/new/.test(html));
  ok('empty section says none found', /None\. Every sitemap URL whose status was observed returned 200\./.test(html));

  const tmp = `${process.env.TEMP || '/tmp'}/orphanage-report-selftest.html`;
  writeFileSync(tmp, html, 'utf8');
  ok('--check passes on clean output', check(tmp) === 0);

  writeFileSync(tmp, html.replace('</head>', '<script>x()</script></head>'), 'utf8');
  ok('--check catches injected <script>', check(tmp) === 1);

  writeFileSync(tmp, html.replace(/ open>/, '>'), 'utf8');
  ok('--check catches a collapsed <details>', check(tmp) === 1);

  writeFileSync(tmp, html.replace(/overflow-wrap:\s*anywhere/gi, 'overflow-wrap:normal'), 'utf8');
  ok('--check catches missing overflow-wrap: anywhere', check(tmp) === 1);

  writeFileSync(tmp, html.replace('<meta name="viewport" content="width=device-width,initial-scale=1">', ''), 'utf8');
  ok('--check catches missing viewport meta', check(tmp) === 1);

  const passed = t.filter(Boolean).length;
  process.stdout.write(`\nreport selftest: ${passed}/${t.length} passed\n`);
  return passed === t.length ? 0 : 1;
}

// ---- cli -----------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest());
  if (argv.includes('--check')) {
    const f = argv[argv.indexOf('--check') + 1];
    if (!f || !existsSync(f)) {
      process.stderr.write('usage: report.mjs --check <report.html>\n');
      process.exit(2);
    }
    process.exit(check(f));
  }
  process.stderr.write('usage: report.mjs --check <report.html>\n       report.mjs --selftest\n');
  process.exit(2);
}
