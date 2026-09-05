// pages.mjs — a small, hand-built fixture site used two ways:
//   1. tests/integration.test.mjs turns this table into an in-memory fake
//      fetch (zero sockets, zero DNS) and runs the whole pipeline against it.
//   2. fixtures/site/server.mjs serves the exact same table over real
//      loopback HTTP, for a one-off manual demonstration that the CLI
//      produces a real, passing report against a real (if tiny, local) site.
//
// Deliberately covers all six finding categories exactly once each, so the
// expected counts in the integration test are easy to reason about:
//   - orphans:            /orphan, /gone           (2)
//   - unlisted:           /secret                  (1)
//   - broken link:        /missing (404)           (1)
//   - redirect chain:     /old-contact -> /contact (1)
//   - deep page (>3):     /blog/post-4 (depth 4)   (1)
//   - dead sitemap entry: /gone (probed, 410)      (1)
//   - robots-blocked:     /private/page            (1, informational only)

const nav = (links) => links.map((l) => `<a href="${l}">${l}</a>`).join('\n');

export const pages = {
  '/': {
    status: 200,
    body: `<html><body><h1>Home</h1>${nav(['/about', '/blog', '/old-contact', '/private/page'])}</body></html>`,
  },
  '/about': {
    status: 200,
    body: `<html><body><h1>About</h1>${nav(['/', '/contact', '/secret', '/missing'])}</body></html>`,
  },
  '/contact': {
    status: 200,
    body: `<html><body><h1>Contact</h1>${nav(['/'])}</body></html>`,
  },
  '/secret': {
    status: 200,
    body: `<html><body><h1>Secret (unlisted)</h1>${nav(['/'])}</body></html>`,
  },
  '/missing': {
    status: 404,
    body: `<html><body>Not found</body></html>`,
  },
  '/old-contact': {
    status: 301,
    location: '/contact',
    body: '',
  },
  '/private/page': {
    status: 200,
    body: `<html><body><h1>Private (robots-disallowed)</h1>${nav(['/'])}</body></html>`,
  },
  '/blog': {
    status: 200,
    body: `<html><body><h1>Blog</h1>${nav(['/', '/blog/post-1', '/blog/post-2'])}</body></html>`,
  },
  '/blog/post-1': {
    status: 200,
    body: `<html><body><h1>Post 1</h1>${nav(['/blog', '/blog/post-3'])}</body></html>`,
  },
  '/blog/post-2': {
    status: 200,
    body: `<html><body><h1>Post 2</h1>${nav(['/blog'])}</body></html>`,
  },
  '/blog/post-3': {
    status: 200,
    body: `<html><body><h1>Post 3</h1>${nav(['/blog/post-1', '/blog/post-4'])}</body></html>`,
  },
  '/blog/post-4': {
    status: 200,
    body: `<html><body><h1>Post 4 (deep — 4 clicks from root)</h1>${nav(['/blog/post-3'])}</body></html>`,
  },
  '/orphan': {
    // In the sitemap; nothing on the site links to it, so the crawl never
    // discovers it. That is the whole point of this fixture entry.
    status: 200,
    body: `<html><body><h1>Orphan</h1>${nav(['/'])}</body></html>`,
  },
  '/gone': {
    // In the sitemap; nothing links to it AND it is dead. Demonstrates a
    // sitemap entry that is both an orphan and a dead entry at once.
    status: 410,
    body: `<html><body>Gone</body></html>`,
  },
};

export const robotsTxt = [
  'User-agent: *',
  'Disallow: /private/',
  'Sitemap: {{ORIGIN}}/sitemap.xml',
  '',
].join('\n');

const SITEMAP_PATHS = [
  '/',
  '/about',
  '/contact',
  '/blog',
  '/blog/post-1',
  '/blog/post-2',
  '/blog/post-3',
  '/blog/post-4',
  '/orphan',
  '/gone',
];

export function sitemapXmlFor(origin) {
  const urls = SITEMAP_PATHS.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robotsTxtFor(origin) {
  return robotsTxt.replace('{{ORIGIN}}', origin);
}

export const EXPECTED = {
  orphans: ['/orphan', '/gone'].sort(),
  unlisted: ['/secret'],
  brokenLinks: ['/missing'],
  redirectChains: ['/old-contact'],
  deepPages: ['/blog/post-4'],
  deadSitemapEntries: ['/gone'],
  robotsBlocked: ['/private/page'],
  sitemapUrlCount: SITEMAP_PATHS.length,
};
