# orphanage

A crawl-graph and orphan-page auditor.

A page that nothing links to is a page search engines and AI crawlers will
rarely find, no matter how good it is. Sites routinely publish pages that
exist in the sitemap but are unreachable by following links from the
homepage, and nobody notices, because most SEO tooling only tests the pages
it already knows about.

This tool crawls a site the way a crawler does (follow links from a root),
separately reads the declared sitemap, and reports the difference. It is
deterministic, makes no calls to any paid service, and costs nothing to run
beyond the requests it makes to the site itself.

## What it is not

A sibling tool (built separately) handles per-user-agent HTTP probing:
whether GPTBot, ClaudeBot, or Googlebot specifically get blocked, and
whether a page depends on JavaScript rendering to show its content. This
tool does none of that. It crawls once, with one ordinary browser-style
User-Agent, and reports on the link graph and the sitemap. If a finding in
this report depends on which crawler you are, it is out of scope here.

## Install

No install step and no runtime dependencies. Clone it and run it with Node
(tested on Node 24; anything 20 or newer should work, since it only uses
built-in `fetch`, `node:zlib`, and `node:http`):

```
node bin/orphanage.mjs <url> [options]
```

## Usage

```
orphanage <url> [--max-pages N] [--delay-ms N] [--max-depth N]
          [--out report.html] [--json out.json]
orphanage --check <report.html>
```

- `--max-pages N`: stop after crawling this many pages (default 500).
- `--delay-ms N`: wait this long between requests (default 1000, i.e. one
  request per second). This is the polite default; lowering it is your call
  to make about a site you have the right to hammer.
- `--max-depth N`: a page more than this many clicks from the root is
  flagged as hard to discover (default 3). This does not limit how far the
  crawler actually goes; it only sets the threshold for the "deep pages"
  finding, because limiting the crawl itself would make orphan detection
  unreliable.
- `--out report.html`: where to write the HTML report (default
  `report.html`).
- `--json out.json`: also write the raw findings as JSON, for CI or for
  feeding into something else.
- `--check report.html`: re-run the report's own self-check against an
  already-generated file (see "The report" below) and exit non-zero if it
  fails.

The command exits non-zero if any finding was produced, or if the report it
just wrote fails its own self-check, so it can be wired into CI directly.

## What each finding means

- **Orphans**: a URL in the sitemap that the crawl never reached by
  following links from the root. This is the headline finding: it means the
  page is effectively invisible to anything that discovers pages by
  crawling rather than by reading the sitemap.
- **Unlisted**: a URL the crawl reached and got a live (200) response
  from, but which is not declared in the sitemap.
- **Broken internal links**: a URL that something on the site links to,
  which returned a 4xx/5xx status or failed outright, along with every page
  that links to it.
- **Redirect chains**: an internal link that points at a URL which
  redirects, with the full chain of hops to its final destination.
- **Deep pages**: a URL the crawl reached, but only more than
  `--max-depth` clicks from the root.
- **Dead sitemap entries**: a URL in the sitemap whose live status was
  actually observed (either while crawling, or by a separate check against
  sitemap URLs the crawl never reached) and was not 200.

There is also an informational section for pages this tool's own robots.txt
compliance kept it from fetching. Those are never counted as orphans or
dead entries: the tool found a link to them, it simply chose not to follow
it, out of the same politeness it asks of every other crawler.

## Honesty rules this tool follows

- If the crawl hits its page cap, the report says so, explicitly, next to
  the orphan and unlisted findings, because a truncated crawl cannot tell a
  genuine orphan apart from a page it simply had not reached yet.
- If robots.txt blocks part of the site, the report says which pages were
  excluded by this tool's own compliance, not that those pages do not
  exist.
- A "dead sitemap entry" is only reported for a URL whose status was
  actually observed. A sitemap URL that was neither crawled nor separately
  checked is reported as "unknown status," never guessed at.

## The report

The report is one self-contained HTML file: no network requests when it
opens, no JavaScript, every collapsible section open by default (a
collapsed `<details>` disappears entirely from a printed PDF), a print
stylesheet, a mobile viewport tag, and `overflow-wrap: anywhere` on every
URL cell so a long URL cannot push the layout wider than a phone screen.

`--check` verifies exactly those properties against a generated report and
fails if any of them is missing. Every rule `--check` enforces has a test
in `tests/report.test.mjs` that deliberately breaks the report in that one
way and confirms `--check` catches it; a check that cannot fail is not a
check.

## How URLs are compared

Two URLs are treated as the same page only if they are identical once the
fragment (`#...`) is stripped. `/about` and `/about/` are reported as two
different URLs. So are `http://example.com/x` and `https://example.com/x`.
This tool does not guess at equivalence a site never declared; if a
sitemap and a crawl disagree only by a trailing slash or a scheme, that
shows up honestly as both an orphan and an unlisted page, and the fix is on
the site's side (pick one canonical form and use it consistently), not in
this tool's normalization logic.

## Testing

```
npm test
```

Runs on Node's built-in test runner (`node --test`), zero dependencies.
As of this build: 48 tests, all passing. They cover:

- the analysis logic (`src/analyse.mjs`) as pure functions over small,
  hand-built fixture graphs, not over any network;
- robots.txt parsing, including wildcard patterns, the `$` end-anchor,
  `Allow` overriding a less-specific `Disallow`, grouped user-agent blocks,
  and a missing/empty robots.txt meaning "allowed";
- the crawler's page cap and rate limit, driven by an injected fetch and an
  injected, non-sleeping clock, so the test suite never waits on a real
  timer or opens a real socket;
- sitemap parsing, including a `<sitemapindex>` that points at child
  sitemaps, gzip decompression via the built-in `node:zlib`, and an honest
  skip (with a stated reason) for a sitemap over the 50MB in-memory safety
  cap;
- an end-to-end run of the whole pipeline against a fixture site
  (`fixtures/site/pages.mjs`), still entirely through an injected fetch,
  checked against an exact expected set of findings.

`fixtures/site/server.mjs` serves that same fixture site over real loopback
HTTP. It is not used by `npm test`; it exists so the CLI can be run against
a real, if tiny and local, site as a manual demonstration:

```
node fixtures/site/server.mjs &
node bin/orphanage.mjs http://127.0.0.1:<the port it printed>
```

## Limitations

- **Links are found with a regex over served HTML, not a browser.** If a
  page's navigation is injected by client-side JavaScript, this tool cannot
  see it and will report reachable pages as orphaned. It sees exactly what
  a crawler that does not execute JavaScript would see.
- **It has no opinion on whether a page deserves to be indexed.** It only
  reports on link-graph and sitemap coherence. A correctly-orphaned page
  that should stay orphaned (a thank-you page, an internal preview) will
  still show up in the orphans list; deciding that is a judgment call for a
  person, not this tool.
- **URL comparison is exact, not fuzzy** (see "How URLs are compared"
  above). Trailing slashes, scheme differences, and default ports are not
  reconciled.
- **Sitemap size has a hard cap.** A sitemap over 50MB uncompressed is
  skipped, with the reason stated in the report, rather than loaded fully
  into memory.
- **This tool does not check per-crawler access or JS-rendering gaps.**
  That is the explicit job of a separate, sibling tool.

## Demo

A generated report against this project's own fixture site is committed at
[`site/report.html`](site/report.html) &mdash; open it in a browser for a real demo
of the report format, with all six finding categories populated at once. It
was produced by running the exact commands in `fixtures/site/server.mjs`'s
own header comment, and it passes `orphanage --check` like any other report.

## License

MIT. See `LICENSE`.
