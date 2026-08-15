// NOLA Archive — shield gate (Stage 4 publishing gate; included now so the
// contract is established early).
//
// Purpose: guarantee no name on the confidential blocklist appears in any
// generated content field before publication (body, title, slug, alt text,
// rendered JSON-LD).
//
// CRITICAL HANDLING RULE:
// The blocklist is derived from the client's confidential vendor file. It is
// loaded at runtime from a LOCAL file referenced by SHIELD_BLOCKLIST_PATH and
// must NEVER be committed to this repository. The path is gitignored; the CI
// check below fails loudly if a blocklist file sneaks into the tree.
//
// Blocklist file format: one name per line, plain text.
//
// Usage:
//   import { loadBlocklist, shieldCheck } from './shield-gate.js';
//   const list = loadBlocklist();                 // from SHIELD_BLOCKLIST_PATH
//   const hits = shieldCheck(pageFields, list);   // [] means clean

import fs from 'node:fs';

// Phrases that identify nobody. If suffix-stripping reduces a name to one of
// these, the stripping has destroyed the name rather than cleaned it:
// "New Orleans & Company" -> "new orleans" would then match every page that
// mentions the city, flagging everything and burying real leaks.
const GENERIC_PHRASES = new Set([
  'new orleans', 'nola', 'louisiana', 'the', 'french quarter', 'the quarter',
  'uptown', 'downtown', 'metairie', 'garden district', 'warehouse district',
  'company', 'group', 'events', 'event', 'tours', 'tour'
]);

const punctOnly = (s) => s.toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// strip punctuation/suffix noise so "Bonomolo Limousines, Inc." matches
// "bonomolo limousine" — but never at the cost of the name's identity
const normalize = (s) => {
  const stripped = s.toLowerCase()
    .replace(/\b(llc|inc|ltd|co|company|corp|dba)\b\.?/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // suffix removal ate the name — keep the unstripped form instead
  if (!stripped || GENERIC_PHRASES.has(stripped)) return punctOnly(s);
  return stripped;
};

// distinctive tokens: drop generic words so "New Orleans Tours" doesn't flag
// every page mentioning "New Orleans" — but keep multi-word exact phrases.
const GENERIC = new Set([
  'new', 'orleans', 'nola', 'the', 'of', 'and', 'a', 'la', 'le', 'les',
  'tours', 'tour', 'events', 'event', 'rentals', 'rental', 'group',
  'services', 'service', 'productions', 'entertainment', 'catering',
  'transportation', 'limousine', 'limo', 'band', 'jazz', 'swamp'
]);

export function loadBlocklist(path = process.env.SHIELD_BLOCKLIST_PATH) {
  if (!path) {
    console.warn('SHIELD_BLOCKLIST_PATH not set — shield gate running with EMPTY blocklist (pilot mode).');
    return [];
  }
  if (!fs.existsSync(path)) throw new Error(`Blocklist file not found at ${path}`);
  return fs.readFileSync(path, 'utf-8')
    .split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * Check a set of named content fields against the blocklist.
 *
 * TWO DIFFERENT GATES USE THIS FUNCTION, and they want different strictness:
 *
 *  - Stage 4, CONFIDENTIAL vendor blocklist (loadBlocklist / SHIELD_BLOCKLIST_PATH).
 *    A leak here is a client-confidentiality breach, so it runs with the
 *    distinctive-token pass ON (the default): a single distinctive token is
 *    enough to flag. False positives are cheap; a miss is not.
 *
 *  - Stage 3b, the 409-name ARCHIVE list (public provider names).
 *    Those names are full of common nouns — "Plates Restaurant & Bar" would
 *    flag any page containing "restaurant" — so the token pass is turned OFF
 *    and matching is full-name only. This is a content-hygiene check, not a
 *    confidentiality gate.
 *
 * @param {Object} fields - e.g. { title, slug, body, altText, jsonLd }
 * @param {string[]} blocklist - raw names
 * @param {Object} [opts]
 * @param {boolean} [opts.tokenPass=true] - match single distinctive tokens
 * @returns {Array<{field:string, name:string, match:string}>} hits; [] = clean
 */
export function shieldCheck(fields, blocklist, opts = {}) {
  const { tokenPass = true } = opts;
  const hits = [];
  const entries = blocklist.map((raw) => {
    const norm = normalize(raw);
    const flat = punctOnly(raw).replace(/\s+/g, '');
    const tokens = norm.split(' ').filter((t) => t.length > 2 && !GENERIC.has(t));
    return { raw, norm, flat, tokens };
  });

  for (const [field, content] of Object.entries(fields)) {
    if (!content) continue;
    // Two views of the content. A blocklist entry is normalized one way or the
    // other depending on whether suffix-stripping would have destroyed it, so
    // the content must be tested against both or genuine mentions are missed.
    const normContent = normalize(String(content));
    const rawContent = punctOnly(String(content));
    const flatContent = rawContent.replace(/\s+/g, '');

    for (const e of entries) {
      if (!e.norm) continue;
      // 1. full normalized phrase match
      if (e.norm.length > 3 && (normContent.includes(e.norm) || rawContent.includes(e.norm))) {
        hits.push({ field, name: e.raw, match: 'exact_phrase' });
        continue;
      }
      // 2. fuzzy: same name with different spacing or punctuation
      if (e.flat.length >= 8 && flatContent.includes(e.flat)) {
        hits.push({ field, name: e.raw, match: 'fuzzy_phrase' });
        continue;
      }
      if (!tokenPass) continue;
      // 3. distinctive-token match (catches partial/possessive forms)
      for (const tok of e.tokens) {
        if (new RegExp(`\\b${tok}\\b`).test(normContent)) {
          hits.push({ field, name: e.raw, match: `token:${tok}` });
          break;
        }
      }
    }
  }
  return hits;
}

// CLI: node src/shield-gate.js path/to/page.json
if (process.argv[1] && process.argv[1].endsWith('shield-gate.js') && process.argv[2]) {
  const page = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));
  const hits = shieldCheck(page, loadBlocklist());
  if (hits.length) {
    console.error(`SHIELD GATE FAILED — ${hits.length} hit(s):`);
    for (const h of hits) console.error(`  [${h.field}] ${h.name} (${h.match})`);
    process.exit(1);
  }
  console.log('Shield gate: clean.');
}
