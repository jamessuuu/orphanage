// robots.mjs — a small, dependency-free robots.txt parser and matcher.
//
// Implements the parts of RFC 9309 / the de-facto Google extensions that a
// polite crawler actually needs:
//   - group parsing (consecutive User-agent lines share a group until a rule
//     line is seen; the next User-agent line after that starts a new group)
//   - group selection: an exact (case-insensitive) product-token match wins
//     over "*"; if nothing matches, everything is allowed
//   - `*` (wildcard) and trailing `$` (end-anchor) in Allow/Disallow values
//   - longest-match-wins, with Allow beating Disallow on an exact tie
//   - a missing or empty robots.txt means "allowed" — this module never
//     invents a restriction that wasn't written down
//
// This module does no I/O. Callers fetch robots.txt themselves and hand the
// text (or undefined/empty string, for "no robots.txt found") to parseRobots.

const ESCAPE_RE = /[.+^${}()|[\]\\]/; // regex-special chars we must escape (not "*" or "?")

function escapeChar(c) {
  return ESCAPE_RE.test(c) ? `\\${c}` : c;
}

// Compile a robots.txt path pattern ("/a/*.pdf$") into a RegExp anchored at
// the start of the path. "*" matches any run of characters; a trailing "$"
// anchors the end of the string; anything else is matched literally.
function compilePattern(pattern) {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      re += '.*';
    } else if (c === '$' && i === pattern.length - 1) {
      re += '$';
    } else {
      re += escapeChar(c);
    }
  }
  return new RegExp(re);
}

function matchesPattern(pathWithQuery, pattern) {
  // An empty Disallow/Allow value ("Disallow:") matches nothing, per spec —
  // it is a no-op line, not "match everything".
  if (pattern === '') return false;
  try {
    return compilePattern(pattern).test(pathWithQuery);
  } catch {
    return false;
  }
}

/**
 * Parse robots.txt content into a matcher for one specific user-agent token.
 *
 * @param {string} text - the raw robots.txt body. Empty/undefined is treated
 *   as "no robots.txt" (allow everything).
 * @param {string} userAgent - the crawler's own UA string (or just its
 *   product token, e.g. "OrphanageBot"). Matched case-insensitively as a
 *   substring against each group's declared agent tokens.
 * @returns {{ isAllowed(pathWithQuery: string): boolean, sitemaps: string[], groups: object[] }}
 */
export function parseRobots(text, userAgent = 'OrphanageBot') {
  const groups = [];
  const sitemaps = [];
  let current = null;
  const lines = String(text ?? '').split(/\r\n|\r|\n/);

  for (const raw of lines) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      // A fresh group starts unless the current group has seen no rules yet
      // (i.e. this is another agent line for the same group).
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (field === 'allow' || field === 'disallow') {
      if (!current) {
        current = { agents: ['*'], rules: [] };
        groups.push(current);
      }
      current.rules.push({ type: field, pattern: value });
    } else if (field === 'sitemap') {
      if (value) sitemaps.push(value);
    }
    // crawl-delay and other fields are ignored on purpose — out of scope.
  }

  const uaToken = String(userAgent ?? '').toLowerCase();
  const exact = groups.filter((g) => g.agents.some((a) => a !== '*' && uaToken.includes(a)));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const chosen = exact.length ? exact : wildcard;
  const rules = chosen.flatMap((g) => g.rules);

  function isAllowed(pathWithQuery) {
    if (!rules.length) return true;
    let best = null;
    for (const rule of rules) {
      if (!matchesPattern(pathWithQuery, rule.pattern)) continue;
      const specificity = rule.pattern.length;
      if (
        !best ||
        specificity > best.specificity ||
        (specificity === best.specificity && rule.type === 'allow' && best.type === 'disallow')
      ) {
        best = { type: rule.type, specificity };
      }
    }
    if (!best) return true;
    return best.type === 'allow';
  }

  return { isAllowed, sitemaps, groups };
}

/** A matcher that allows everything — used when robots.txt cannot be fetched. */
export function allowAllRobots() {
  return parseRobots('', 'OrphanageBot');
}
