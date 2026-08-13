// NOLA Archive — Stage 1 discovery seeder
//
// Expands the provider universe from the 10 pilot seeds to the full public
// set of Greater New Orleans event/experience providers.
//
// DISCOVERY ONLY. This script enumerates providers and inserts them as
// 'pending'. It never researches anything and never writes facts, services,
// or sources. Run `npm run research` separately, and only deliberately —
// the research agent picks up every pending provider it finds.
//
// Checkpointed in discovery_runs: a query with a 'complete' row is skipped,
// so the pass is safe to interrupt and re-run.
//
// Usage:  node src/discovery-seeder.js              (all queries)
//         node src/discovery-seeder.js --limit 3    (first 3 unprocessed)
//         node src/discovery-seeder.js --dry-run    (no writes; prints what it would insert)

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MAX_SEARCHES = 3;
const MAX_OUTPUT_TOKENS = 8000;

// ---------- discovery matrix: category x area ----------
// Covers the ten provider categories the archive cares about, spread across
// the neighbourhoods and parishes that make up the Greater New Orleans market.
const DISCOVERY_QUERIES = [
  // venues
  { category: 'venue', area: 'French Quarter', query: 'private event venues French Quarter New Orleans' },
  { category: 'venue', area: 'Warehouse District', query: 'private event venues Warehouse District New Orleans' },
  { category: 'venue', area: 'CBD', query: 'corporate event venues Central Business District New Orleans' },
  { category: 'venue', area: 'Garden District', query: 'historic mansion event venues Garden District New Orleans' },
  { category: 'venue', area: 'Greater New Orleans', query: 'warehouse and loft adaptive reuse event spaces New Orleans' },
  { category: 'venue', area: 'Greater New Orleans', query: 'hotel ballrooms for corporate meetings New Orleans' },
  { category: 'venue', area: 'Greater New Orleans', query: 'museum and attraction private buyouts New Orleans' },
  { category: 'venue', area: 'Greater New Orleans', query: 'rooftop and outdoor event venues New Orleans' },
  { category: 'venue', area: 'Metairie', query: 'event venues Metairie Louisiana' },
  { category: 'venue', area: 'Northshore', query: 'event venues Covington Mandeville Northshore Louisiana' },

  // entertainment
  { category: 'entertainment', area: 'New Orleans', query: 'brass bands for hire New Orleans' },
  { category: 'entertainment', area: 'New Orleans', query: 'jazz musicians and bands for corporate events New Orleans' },
  { category: 'entertainment', area: 'New Orleans', query: 'second line parade services New Orleans' },
  { category: 'entertainment', area: 'New Orleans', query: 'entertainment talent booking agencies New Orleans events' },
  { category: 'entertainment', area: 'New Orleans', query: 'DJs and dance bands for corporate events New Orleans' },

  // activities / tours
  { category: 'activity', area: 'Greater New Orleans', query: 'swamp tours near New Orleans' },
  { category: 'activity', area: 'New Orleans', query: 'corporate team building activities New Orleans' },
  { category: 'activity', area: 'New Orleans', query: 'cooking classes and culinary experiences for groups New Orleans' },
  { category: 'activity', area: 'New Orleans', query: 'walking food and cemetery tours for groups New Orleans' },
  { category: 'activity', area: 'New Orleans', query: 'steamboat and riverboat charters New Orleans' },
  { category: 'activity', area: 'Greater New Orleans', query: 'plantation and day trip tours from New Orleans' },
  { category: 'activity', area: 'New Orleans', query: 'CSR volunteer and give-back group activities New Orleans' },

  // restaurants with private dining
  { category: 'group_dining', area: 'French Quarter', query: 'restaurants with private dining rooms French Quarter New Orleans' },
  { category: 'group_dining', area: 'Warehouse District', query: 'restaurants with private event space Warehouse District New Orleans' },
  { category: 'group_dining', area: 'New Orleans', query: 'large group dining restaurants New Orleans full buyout' },

  // transportation
  { category: 'transportation', area: 'Greater New Orleans', query: 'event transportation companies New Orleans' },
  { category: 'transportation', area: 'Greater New Orleans', query: 'charter bus and motorcoach companies New Orleans' },
  { category: 'transportation', area: 'Greater New Orleans', query: 'limousine and black car services New Orleans' },

  // decor / rentals
  { category: 'event_rentals', area: 'Greater New Orleans', query: 'event rental companies New Orleans tables chairs linens' },
  { category: 'decor', area: 'Greater New Orleans', query: 'event decor and floral design companies New Orleans' },
  { category: 'event_rentals', area: 'Greater New Orleans', query: 'tent staging and dance floor rental New Orleans' },

  // catering
  { category: 'catering', area: 'Greater New Orleans', query: 'off-premise catering companies New Orleans' },
  { category: 'catering', area: 'Greater New Orleans', query: 'corporate catering companies New Orleans events' },

  // staffing
  { category: 'staffing', area: 'Greater New Orleans', query: 'event staffing agencies New Orleans' },
  { category: 'staffing', area: 'Greater New Orleans', query: 'brand ambassador and registration staffing New Orleans' },

  // photography
  { category: 'photography', area: 'Greater New Orleans', query: 'corporate event photographers New Orleans' },
  { category: 'photography', area: 'Greater New Orleans', query: 'event videographers and photo booth companies New Orleans' },

  // gifting
  { category: 'gifting', area: 'Greater New Orleans', query: 'corporate gifting and welcome bag companies New Orleans' },
  { category: 'gifting', area: 'Greater New Orleans', query: 'local artisan gift vendors for corporate groups New Orleans' },

  // production / AV
  { category: 'production', area: 'Greater New Orleans', query: 'audio visual and event production companies New Orleans' },
];

// ---------- discovery prompt (static, cached) ----------
const DISCOVERY_SYSTEM_PROMPT = `You are enumerating the public universe of event and experience providers serving corporate and group programs in the Greater New Orleans area.

You are given ONE discovery query. Use web search to find providers matching it, then return ONLY a JSON array. No prose, no markdown fences, no commentary.

RULES
1. ENUMERATION ONLY. Do not research these providers, do not gather facts about them, do not verify details beyond the business name and the city they operate in. Names and cities only.
2. Only include real, currently-operating businesses that plausibly serve corporate or group events.
3. Only include providers in the Greater New Orleans area: Orleans, Jefferson, St. Bernard, St. Tammany, and St. Charles parishes — including Metairie, Kenner, Slidell, Covington, Mandeville, Chalmette, Gretna, Harvey, and Westwego.
4. Use the provider's official business name as published. No taglines, no descriptive suffixes, no marketing copy in the name field.
5. EXCLUDE: listing aggregators and directories themselves (Yelp, The Knot, Eventective, PartySlate, Peerspace, Tripadvisor and similar), national chains with no local event offering, permanently closed businesses, private residences, and government offices.
6. 3 searches maximum. Be efficient.
7. Return between 0 and 25 providers. Do NOT pad the list to reach a number — if the query surfaces only a few real providers, return only those.

OUTPUT SCHEMA (return exactly this shape — a bare JSON array):
[
  { "name": "string — official business name", "city": "string", "likely_category": "lowercase_snake_case" }
]

Return the JSON array and nothing else.`;

const need = (k) => {
  if (!process.env[k]) { console.error(`Missing env var ${k} — see .env.example`); process.exit(1); }
  return process.env[k];
};

const anthropic = new Anthropic({ apiKey: need('ANTHROPIC_API_KEY') });
const supabase = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'));

const fail = (context, error) => {
  const detail = [error?.code, error?.message, error?.details, error?.hint].filter(Boolean).join(' | ');
  throw new Error(`${context}: ${detail || JSON.stringify(error)}`);
};

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

// Dedup key: lowercase, drop punctuation and corporate suffixes, collapse space.
// "Bonomolo Limousines, Inc." and "bonomolo limousines" collide, as intended.
const normalizeName = (s) => s.toLowerCase()
  .replace(/\b(llc|l\.l\.c|inc|incorporated|ltd|limited|co|company|corp|corporation|dba|the)\b\.?/g, ' ')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// ---------- existing universe (paged: Supabase caps a single select at 1000) ----------
async function loadExisting() {
  const names = new Map(); // normalized -> existing display name
  const slugs = new Set();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('providers').select('name, slug').range(from, from + pageSize - 1);
    if (error) fail('Loading existing providers failed', error);
    for (const p of data) {
      names.set(normalizeName(p.name), p.name);
      slugs.add(p.slug);
    }
    if (data.length < pageSize) break;
  }
  return { names, slugs };
}

async function completedQueries() {
  const done = new Set();
  const { data, error } = await supabase
    .from('discovery_runs').select('query').eq('status', 'complete');
  if (error) fail('Loading discovery_runs failed', error);
  for (const r of data) done.add(r.query);
  return done;
}

// ---------- one discovery query ----------
async function runQuery(q, existing, dupTally, dryRun) {
  console.log(`\n→ [${q.category}] ${q.query}`);

  let run = null;
  if (!dryRun) {
    const { data, error } = await supabase.from('discovery_runs')
      .insert({ query: q.query, category: q.category, area: q.area, model: MODEL })
      .select().single();
    if (error) fail('Creating discovery_run failed', error);
    run = data;
  }

  let usage = {}, searchCount = 0;
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: [{ type: 'text', text: DISCOVERY_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES }],
      messages: [{
        role: 'user',
        content: `Discovery query: ${q.query}\nFocus area: ${q.area}\nReturn the JSON array.`
      }]
    });

    usage = response.usage || {};
    searchCount = (response.content || []).filter((b) => b.type === 'server_tool_use').length;

    if (response.stop_reason === 'max_tokens') {
      throw new Error(`Response truncated at max_tokens (${MAX_OUTPUT_TOKENS})`);
    }

    const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const jsonStr = text.replace(/```json|```/g, '').trim();
    const start = jsonStr.indexOf('[');
    const end = jsonStr.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error('No JSON array in model output');
    const candidates = JSON.parse(jsonStr.slice(start, end + 1));
    if (!Array.isArray(candidates)) throw new Error('Model output was not an array');

    let inserted = 0, skipped = 0;
    for (const c of candidates) {
      if (!c?.name || typeof c.name !== 'string') { skipped++; continue; }
      const norm = normalizeName(c.name);
      const slug = slugify(c.name);
      if (!norm || !slug) { skipped++; continue; }

      if (existing.names.has(norm) || existing.slugs.has(slug)) {
        skipped++;
        dupTally.set(norm, (dupTally.get(norm) || 0) + 1);
        continue;
      }

      if (dryRun) {
        console.log(`   + ${c.name} (${c.city || 'New Orleans'})`);
      } else {
        const { error } = await supabase.from('providers').insert({
          name: c.name.trim(),
          slug,
          city: (c.city || 'New Orleans').trim(),
          categories: c.likely_category ? [c.likely_category] : [q.category],
          status: 'pending',
          discovered_from: q.query
        });
        if (error) {
          // 23505 = someone else inserted the same slug; treat as a duplicate
          if (error.code === '23505') { skipped++; dupTally.set(norm, (dupTally.get(norm) || 0) + 1); continue; }
          fail(`Inserting provider ${c.name}`, error);
        }
      }
      // claim the name even in dry-run so within-run duplicates are counted
      existing.names.set(norm, c.name);
      existing.slugs.add(slug);
      inserted++;
    }

    if (!dryRun) {
      await supabase.from('discovery_runs').update({
        status: 'complete',
        providers_found: candidates.length, inserted, skipped,
        searches_used: searchCount,
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_read_tokens: usage.cache_read_input_tokens || 0,
        finished_at: new Date().toISOString()
      }).eq('id', run.id);
    }

    console.log(`  ✓ ${candidates.length} found, ${inserted} inserted, ${skipped} skipped, ${searchCount} searches`);
    return { found: candidates.length, inserted, skipped };
  } catch (err) {
    console.error(`  ✗ ${err.message}`);
    if (!dryRun) {
      await supabase.from('discovery_runs').update({
        status: 'failed', searches_used: searchCount,
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_read_tokens: usage.cache_read_input_tokens || 0,
        error: err.message, finished_at: new Date().toISOString()
      }).eq('id', run.id);
    }
    return { found: 0, inserted: 0, skipped: 0, failed: true };
  }
}

// ---------- main ----------
const arg = (flag) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : null; };
const dryRun = process.argv.includes('--dry-run');
const limit = arg('--limit') ? parseInt(arg('--limit'), 10) : Infinity;

const existing = await loadExisting();
const done = dryRun ? new Set() : await completedQueries();
console.log(`Universe before discovery: ${existing.names.size} providers.`);
if (dryRun) console.log('DRY RUN — no writes.');

const todo = DISCOVERY_QUERIES.filter((q) => !done.has(q.query)).slice(0, limit);
console.log(`${todo.length} of ${DISCOVERY_QUERIES.length} queries to run (${done.size} already complete).`);

const dupTally = new Map();
let totals = { found: 0, inserted: 0, skipped: 0, failed: 0 };

for (const q of todo) {
  const r = await runQuery(q, existing, dupTally, dryRun);
  totals.found += r.found; totals.inserted += r.inserted; totals.skipped += r.skipped;
  if (r.failed) totals.failed++;
  await new Promise((res) => setTimeout(res, 1500)); // gentle pacing
}

console.log(`\n=== discovery summary ===`);
console.log(`queries run     : ${todo.length}${totals.failed ? ` (${totals.failed} failed)` : ''}`);
console.log(`providers found : ${totals.found}`);
console.log(`inserted        : ${totals.inserted}`);
console.log(`skipped (dupes) : ${totals.skipped}`);
console.log(`universe now    : ${existing.names.size} providers`);

const topDupes = [...dupTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
if (topDupes.length) {
  console.log(`\ntop duplicates skipped:`);
  for (const [norm, n] of topDupes) console.log(`  ${String(n).padStart(2)}x  ${norm}`);
}

if (!dryRun) {
  const { data: runs } = await supabase
    .from('discovery_runs').select('input_tokens,output_tokens,cache_read_tokens,searches_used');
  const t = (runs || []).reduce((a, r) => ({
    i: a.i + r.input_tokens, o: a.o + r.output_tokens,
    c: a.c + r.cache_read_tokens, s: a.s + r.searches_used
  }), { i: 0, o: 0, c: 0, s: 0 });
  const cost = (t.i / 1e6) * 3 + (t.o / 1e6) * 15 + (t.c / 1e6) * 0.3 + (t.s / 1000) * 10;
  console.log(`\ndiscovery cost  : ${t.s} searches, ${t.i} in / ${t.o} out / ${t.c} cached  ≈ $${cost.toFixed(2)}`);
}

console.log(`\nDiscovery only — nothing has been researched. Providers are 'pending'.`);
console.log(`Review the universe before running: npm run research`);
