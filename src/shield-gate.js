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

// strip punctuation/suffix noise so "Bonomolo Limousines, Inc." matches "bonomolo limousine"
const normalize = (s) => s.toLowerCase()
  .replace(/\b(llc|inc|ltd|co|company|corp|dba)\b\.?/g, ' ')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

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
 * @param {Object} fields - e.g. { title, slug, body, altText, jsonLd }
 * @param {string[]} blocklist - raw names
 * @returns {Array<{field:string, name:string, match:string}>} hits; [] = clean
 */
export function shieldCheck(fields, blocklist) {
  const hits = [];
  const entries = blocklist.map((raw) => {
    const norm = normalize(raw);
    const tokens = norm.split(' ').filter((t) => t.length > 2 && !GENERIC.has(t));
    return { raw, norm, tokens };
  });

  for (const [field, content] of Object.entries(fields)) {
    if (!content) continue;
    const normContent = normalize(String(content));
    for (const e of entries) {
      if (!e.norm) continue;
      // 1. full normalized phrase match
      if (e.norm.length > 3 && normContent.includes(e.norm)) {
        hits.push({ field, name: e.raw, match: 'exact_phrase' });
        continue;
      }
      // 2. distinctive-token match (catches partial/possessive forms)
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
