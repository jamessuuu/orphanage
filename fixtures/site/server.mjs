#!/usr/bin/env node
// server.mjs — serves fixtures/site/pages.mjs over real loopback HTTP.
//
// This is NOT used by the automated test suite (tests must make no network
// calls; see tests/integration.test.mjs for the socket-free equivalent).
// It exists purely so a real report can be generated against a real (if
// tiny, local) site, per the project's "Done means" requirement:
//   node fixtures/site/server.mjs
//   node bin/orphanage.mjs http://127.0.0.1:<port> --out demo-report.html
//
// Usage: node fixtures/site/server.mjs [port]   (default: 0 = ephemeral)

import { createServer } from 'node:http';
import { pages, robotsTxtFor, sitemapXmlFor } from './pages.mjs';

const port = Number(process.argv[2] ?? 0);

const server = createServer((req, res) => {
  const origin = `http://${req.headers.host}`;
  const u = new URL(req.url, origin);

  if (u.pathname === '/robots.txt') {
    const body = robotsTxtFor(origin);
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  if (u.pathname === '/sitemap.xml') {
    const body = sitemapXmlFor(origin);
    res.writeHead(200, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  const desc = pages[u.pathname];
  if (!desc) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  const headers = { 'content-type': 'text/html', ...(desc.headers || {}) };
  if (desc.location) headers.location = desc.location;
  res.writeHead(desc.status, headers);
  res.end(desc.body ?? '');
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  process.stdout.write(`fixture site listening at http://127.0.0.1:${addr.port}\n`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
