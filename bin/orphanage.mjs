#!/usr/bin/env node
// orphanage — crawl-graph and orphan-page auditor.
//
// Crawls a site the way a crawler does (follow same-origin <a href> links
// from a root), separately reads the declared sitemap, and reports the
// difference: orphans, unlisted pages, broken internal links, redirect
// chains, hard-to-discover pages, and dead sitemap entries.
//
// This tool does not do per-user-agent bot probing, JS rendering, or
// robots-blocking checks for other crawlers — that is a sibling tool's job.
// It crawls politely with one honest User-Agent, respects robots.txt for
// itself, and reports only what it actually measured.
//
// Usage:
//   orphanage <url> [--max-pages N] [--delay-ms N] [--max-depth N]
//             [--out report.html] [--json out.json]
//   orphanage --check <report.html>

import { writeFileSync } from 'node:fs';
import { crawl, verifyUrls, DEFAULT_MAX_PAGES, DEFAULT_DELAY_MS } from '../src/crawl.mjs';
import { fetchSitemap } from '../src/sitemap.mjs';
import { analyse, normalizeUrl } from '../src/analyse.mjs';
import { renderReport, check } from '../src/report.mjs';

const DEFAULT_MAX_DEPTH = 3;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function usage() {
  process.stderr.write(
    'usage: orphanage <url> [--max-pages N] [--delay-ms N] [--max-depth N]\n' +
      '                 [--out report.html] [--json out.json]\n' +
      '       orphanage --check <report.html>\n',
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (typeof args.check === 'string') {
    process.exit(check(args.check));
  }

  const rootUrl = args._[0];
  if (!rootUrl) {
    usage();
    process.exit(2);
  }
  let parsedRoot;
  try {
    parsedRoot = new URL(rootUrl);
  } catch {
    process.stderr.write(`orphanage: "${rootUrl}" is not a valid URL\n`);
    process.exit(2);
  }
  if (parsedRoot.protocol !== 'http:' && parsedRoot.protocol !== 'https:') {
    process.stderr.write('orphanage: only http:// and https:// roots are supported\n');
    process.exit(2);
  }

  const maxPages = args['max-pages'] ? parseInt(args['max-pages'], 10) : DEFAULT_MAX_PAGES;
  const delayMs = args['delay-ms'] ? parseInt(args['delay-ms'], 10) : DEFAULT_DELAY_MS;
  const maxDepth = args['max-depth'] ? parseInt(args['max-depth'], 10) : DEFAULT_MAX_DEPTH;
  const outPath = typeof args.out === 'string' ? args.out : 'report.html';
  const jsonPath = typeof args.json === 'string' ? args.json : null;

  process.stdout.write(
    `orphanage: crawling ${parsedRoot.toString()} (cap ${maxPages} pages, ${delayMs}ms between requests)\n`,
  );
  const crawlResult = await crawl({ rootUrl: parsedRoot.toString(), maxPages, delayMs });
  process.stdout.write(
    `orphanage: fetched ${crawlResult.fetchedCount} page(s), discovered ${
      Object.keys(crawlResult.pages).length
    } URL(s) total. robots.txt: ${crawlResult.robots.status}\n`,
  );
  if (crawlResult.truncated) {
    process.stdout.write(
      `orphanage: WARNING — crawl hit the ${maxPages}-page cap. Orphan/unlisted results below are incomplete.\n`,
    );
  }

  process.stdout.write('orphanage: fetching sitemap...\n');
  const sitemapResult = await fetchSitemap({
    rootUrl: parsedRoot.toString(),
    candidateUrls: crawlResult.robots.sitemaps,
    delayMs,
  });
  process.stdout.write(
    `orphanage: sitemap declares ${sitemapResult.urls.length} URL(s) across ${sitemapResult.sitemapsFetched.length} sitemap file(s)${
      sitemapResult.errors.length ? `, ${sitemapResult.errors.length} error(s)` : ''
    }\n`,
  );

  const discovered = new Set(Object.keys(crawlResult.pages).map(normalizeUrl));
  const toVerify = [...new Set(sitemapResult.urls.map(normalizeUrl))].filter(
    (u) => !discovered.has(u),
  );
  let sitemapStatus = {};
  if (toVerify.length) {
    process.stdout.write(
      `orphanage: verifying live status of ${toVerify.length} sitemap URL(s) not reached while crawling...\n`,
    );
    sitemapStatus = await verifyUrls(toVerify, { delayMs, userAgent: crawlResult.userAgent });
  }

  const findings = analyse({
    root: crawlResult.root,
    pages: crawlResult.pages,
    sitemapUrls: sitemapResult.urls,
    sitemapStatus,
    maxDepth,
    truncated: crawlResult.truncated,
    maxPages: crawlResult.maxPages,
  });

  const meta = {
    userAgent: crawlResult.userAgent,
    robotsStatus: crawlResult.robots.status,
    delayMs: crawlResult.delayMs,
    sitemapSources: sitemapResult.sitemapsFetched,
    sitemapErrors: sitemapResult.errors,
    sitemapSkipped: sitemapResult.skipped,
  };

  const html = renderReport(findings, meta);
  writeFileSync(outPath, html, 'utf8');
  const selfCheck = check(outPath);
  process.stdout.write(
    `orphanage: report written to ${outPath} (self-check: ${selfCheck === 0 ? 'passed' : 'FAILED'})\n`,
  );

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({ meta, findings }, null, 2), 'utf8');
    process.stdout.write(`orphanage: findings JSON written to ${jsonPath}\n`);
  }

  process.stdout.write('\n');
  process.stdout.write(`Orphans:                ${findings.orphans.length}\n`);
  process.stdout.write(`Unlisted:                ${findings.unlisted.length}\n`);
  process.stdout.write(`Broken internal links:   ${findings.brokenLinks.length}\n`);
  process.stdout.write(`Redirect chains:         ${findings.redirectChains.length}\n`);
  process.stdout.write(`Deep pages (>${maxDepth} clicks):    ${findings.deepPages.length}\n`);
  process.stdout.write(`Dead sitemap entries:    ${findings.deadSitemapEntries.length}\n`);
  if (findings.truncated) {
    process.stdout.write(
      `\ncrawl was truncated at ${findings.maxPages} pages, orphan results are therefore incomplete\n`,
    );
  }

  const exitCode = findings.counts.findingsCount > 0 || selfCheck !== 0 ? 1 : 0;
  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`orphanage: fatal error: ${err.stack || err.message}\n`);
  process.exit(2);
});
