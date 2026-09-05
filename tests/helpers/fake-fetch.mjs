// fake-fetch.mjs — an in-memory fetch() replacement for tests. No sockets,
// no DNS, no timers beyond what a test explicitly injects. Matches requests
// by pathname against a route table; anything not in the table is a 404.

function makeResponse({ status, body = '', headers = {}, location }) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (location) h.set('location', location);
  return {
    status,
    headers: { get: (name) => h.get(String(name).toLowerCase()) ?? null },
    async text() {
      return body;
    },
    async arrayBuffer() {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf8');
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
}

/**
 * @param {Record<string, {status:number, body?:string|Buffer, headers?:object, location?:string}>} routes
 *   keyed by pathname (e.g. "/about", "/robots.txt", "/sitemap.xml").
 * @param {{ calls?: string[] }} [track] - optional array that every
 *   requested URL is pushed onto, so a test can assert on request order/count.
 */
export function createFakeFetch(routes, track) {
  return async function fakeFetch(url) {
    if (track?.calls) track.calls.push(String(url));
    const u = new URL(url);
    const desc = routes[u.pathname];
    if (!desc) return makeResponse({ status: 404, body: 'Not Found' });
    return makeResponse(desc);
  };
}

/** A sleep stub that never actually waits, but records every requested delay. */
export function createFakeSleep(track) {
  return async function fakeSleep(ms) {
    track.push(ms);
  };
}
