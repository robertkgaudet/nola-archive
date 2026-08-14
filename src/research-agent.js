// NOLA Archive — Stage 1 research agent (pilot)
// Checkpointed loop: pulls 'pending' providers from Supabase, researches each
// with Claude + web search, writes sourced facts back. Safe to re-run any time;
// completed providers are skipped. Ctrl-C and resume freely.
//
// Usage:  node src/research-agent.js            (process all pending)
//         node src/research-agent.js --limit 3  (process at most 3)

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { EXTRACTION_SYSTEM_PROMPT } from './extraction-prompt.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MAX_SEARCHES = 6;
// A full provider profile (services + facets + sources) runs 2.5k-4k output
// tokens, and richer providers exceed that. At 4000 the JSON was truncated
// mid-array and failed to parse. Keep well clear of the ceiling.
const MAX_OUTPUT_TOKENS = 16000;

const need = (k) => {
  if (!process.env[k]) { console.error(`Missing env var ${k} — see .env.example`); process.exit(1); }
  return process.env[k];
};

const anthropic = new Anthropic({ apiKey: need('ANTHROPIC_API_KEY') });
const supabase = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'));

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

// Extract the FIRST complete, balanced JSON object. The model occasionally
// appends prose after the JSON — most often on short "not found" replies,
// where it wants to justify itself — and a naive indexOf('{')..lastIndexOf('}')
// slice swallows that trailing text and fails to parse. Brace-matching is
// string- and escape-aware so braces inside values don't throw off the depth.
function extractJsonObject(s) {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { if (inStr) esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return null; // never balanced — output was truncated
}

// Supabase error objects stringify to `{ message: '' }` on transport/permission
// failures, which tells you nothing. Surface code/details/hint instead.
const fail = (context, error) => {
  const detail = [error?.code, error?.message, error?.details, error?.hint]
    .filter(Boolean).join(' | ');
  throw new Error(`${context}: ${detail || JSON.stringify(error)}`);
};

// ---------- seed loader (idempotent) ----------
async function seedIfEmpty() {
  // NB: not `head: true` — a HEAD response has no body, so PostgREST errors
  // (permission denied, missing table) come back as an empty `{ message: '' }`.
  const { count, error } = await supabase.from('providers').select('id', { count: 'exact' }).limit(1);
  if (error) fail('Counting providers failed', error);
  if (count > 0) return;
  const { providers } = (await import('../seeds/pilot-providers.json', { with: { type: 'json' } })).default;
  const rows = providers.map((p) => ({
    name: p.name, slug: slugify(p.name), city: p.city,
    categories: p.categories, discovered_from: 'pilot_seed'
  }));
  const { error: insErr } = await supabase.from('providers').insert(rows);
  if (insErr) fail('Seeding pilot providers failed', insErr);
  console.log(`Seeded ${rows.length} pilot providers.`);
}

// ---------- one provider ----------
async function researchProvider(provider) {
  console.log(`\n→ ${provider.name}`);
  await supabase.from('providers').update({ status: 'researching', updated_at: new Date().toISOString() }).eq('id', provider.id);
  const { data: run } = await supabase.from('research_runs')
    .insert({ provider_id: provider.id, model: MODEL }).select().single();

  let usage = {}, searchCount = 0;
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: [{ type: 'text', text: EXTRACTION_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES }],
      messages: [{
        role: 'user',
        content: `Research this provider and return the JSON object.\nName: ${provider.name}\nCity: ${provider.city || 'New Orleans'}\nExpected categories (verify, don't assume): ${(provider.categories || []).join(', ')}`
      }]
    });

    usage = response.usage || {};
    searchCount = (response.content || []).filter((b) => b.type === 'server_tool_use').length;

    // Truncation surfaces downstream as an opaque "Expected ',' or ']'" parse
    // error. Name the real cause instead.
    if (response.stop_reason === 'max_tokens') {
      throw new Error(`Response truncated at max_tokens (${MAX_OUTPUT_TOKENS}) — raise MAX_OUTPUT_TOKENS`);
    }

    const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const jsonStr = text.replace(/```json|```/g, '').trim();
    const slice = extractJsonObject(jsonStr);
    if (!slice) throw new Error('No complete JSON object in model output');
    const data = JSON.parse(slice);

    if (!data.provider?.found) {
      await supabase.from('providers').update({ status: 'not_found', updated_at: new Date().toISOString() }).eq('id', provider.id);
      await finishRun(run.id, 'complete', searchCount, usage);
      console.log(`  not found: ${data.provider?.reason || 'no reason given'}`);
      return;
    }

    // sources first — map ref → row id
    const refMap = {};
    for (const s of data.sources || []) {
      const { data: srcRow, error } = await supabase.from('sources')
        .insert({ provider_id: provider.id, url: s.url, title: s.title || null, publisher: s.publisher || null })
        .select().single();
      if (error) fail(`Inserting source ${s.url}`, error);
      refMap[s.ref] = srcRow.id;
    }

    let facetCount = 0, svcCount = 0;
    for (const svc of data.services || []) {
      const { error } = await supabase.from('services').insert({
        provider_id: provider.id, name: svc.name, description: svc.description || null,
        confidence: svc.confidence || 'medium', source_id: refMap[svc.source_ref] || null
      });
      if (!error) svcCount++;
    }
    for (const f of data.facets || []) {
      if (!refMap[f.source_ref]) continue; // unsourced facts do not enter the archive
      const { error } = await supabase.from('facets').insert({
        provider_id: provider.id, facet_type: f.facet_type, label: f.label, value: f.value,
        value_numeric: f.value_numeric ?? null, unit: f.unit ?? null,
        confidence: f.confidence, source_id: refMap[f.source_ref]
      });
      if (!error) facetCount++;
    }

    await supabase.from('providers').update({
      status: 'complete',
      name: data.provider.confirmed_name || provider.name,
      website: data.provider.website || null,
      city: data.provider.city || provider.city,
      categories: data.provider.categories || provider.categories,
      updated_at: new Date().toISOString()
    }).eq('id', provider.id);
    await finishRun(run.id, 'complete', searchCount, usage);
    console.log(`  ✓ ${svcCount} services, ${facetCount} facets, ${Object.keys(refMap).length} sources, ${searchCount} searches`);
  } catch (err) {
    console.error(`  ✗ ${err.message}`);
    await supabase.from('providers').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', provider.id);
    // keep whatever usage we did incur — a failed run still costs money
    await finishRun(run.id, 'failed', searchCount, usage, err.message);
  }
}

async function finishRun(runId, status, searches, usage, error = null) {
  await supabase.from('research_runs').update({
    status, searches_used: searches,
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    cache_read_tokens: usage.cache_read_input_tokens || 0,
    error, finished_at: new Date().toISOString()
  }).eq('id', runId);
}

// ---------- stratified sampling ----------
// `order('created_at')` returns providers in insertion order, which for a
// discovery-seeded universe means whole categories arrive in blocks — the
// first 25 would be almost entirely venues. For calibration we want a spread
// across categories AND across prominence, so: allocate per-category quotas by
// largest-remainder, then pick randomly inside each category.
//
// Category comes from discovery_runs.category (the controlled matrix axis)
// via providers.discovered_from, not from providers.categories, which holds
// the model's free-text guess and is not consistent enough to stratify on.
async function fetchAllPending() {
  const out = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase.from('providers')
      .select('*').eq('status', 'pending').order('created_at').range(from, from + size - 1);
    if (error) fail('Fetching pending providers failed', error);
    out.push(...data);
    if (data.length < size) break;
  }
  return out;
}

async function categoryByQuery() {
  const map = {};
  const { data, error } = await supabase.from('discovery_runs').select('query, category');
  if (error) return map; // table may not exist yet; fall back to 'unknown'
  for (const r of data) map[r.query] = r.category;
  return map;
}

function allocate(groups, n) {
  const total = Object.values(groups).reduce((a, g) => a + g.length, 0);
  const exact = {}, quota = {};
  for (const [c, g] of Object.entries(groups)) {
    exact[c] = (g.length / total) * n;
    quota[c] = Math.min(Math.floor(exact[c]), g.length);
  }
  // hand out the remainder by largest fractional part
  let left = n - Object.values(quota).reduce((a, v) => a + v, 0);
  const order = Object.keys(groups).sort((a, b) => (exact[b] % 1) - (exact[a] % 1));
  while (left > 0) {
    const before = left;
    for (const c of order) {
      if (left === 0) break;
      if (quota[c] < groups[c].length) { quota[c]++; left--; }
    }
    if (left === before) break; // every category exhausted
  }
  // make sure no represented category is shut out entirely
  for (const c of Object.keys(groups)) {
    if (quota[c] > 0) continue;
    const donor = Object.keys(quota).sort((a, b) => quota[b] - quota[a])[0];
    if (quota[donor] > 1) { quota[donor]--; quota[c] = 1; }
  }
  return quota;
}

async function stratifiedSample(n) {
  const pending = await fetchAllPending();
  const catOf = await categoryByQuery();

  const groups = {};
  for (const p of pending) {
    const c = p.discovered_from === 'pilot_seed'
      ? 'pilot_seed'
      : (catOf[p.discovered_from] || 'unknown');
    (groups[c] ||= []).push(p);
  }

  const quota = allocate(groups, Math.min(n, pending.length));

  const picked = [];
  for (const [c, g] of Object.entries(groups)) {
    const shuffled = [...g].sort(() => Math.random() - 0.5); // prominence mix, not insertion order
    picked.push(...shuffled.slice(0, quota[c]));
  }

  console.log(`Stratified sample of ${picked.length} from ${pending.length} pending:`);
  for (const [c, g] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(quota[c]).padStart(2)} of ${String(g.length).padStart(3)}  ${c}`);
  }
  return picked;
}

// ---------- main ----------
const argVal = (flag) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : null; };
const limit = argVal('--limit') ? parseInt(argVal('--limit'), 10) : 1000;
const sample = argVal('--sample') ? parseInt(argVal('--sample'), 10) : null;

await seedIfEmpty();
// re-queue anything stuck mid-run from a previous interrupted session
await supabase.from('providers').update({ status: 'pending' }).eq('status', 'researching');

let pending;
if (sample) {
  pending = await stratifiedSample(sample);
  // --plan: show the draw and exit without spending anything
  if (process.argv.includes('--plan')) {
    console.log('\n--plan — nothing researched. Selected:');
    for (const p of pending) console.log(`  [${p.city}] ${p.name}`);
    process.exit(0);
  }
} else {
  const { data, error } = await supabase.from('providers')
    .select('*').eq('status', 'pending').order('created_at').limit(limit);
  if (error) fail('Fetching pending providers failed', error);
  pending = data;
  console.log(`${pending.length} provider(s) pending.`);
}

for (const p of pending) {
  await researchProvider(p);
  await new Promise((r) => setTimeout(r, 1500)); // gentle pacing
}

// ---------- convergence check ----------
// Discovery dedupes on the SEEDED name, but research overwrites `name` with
// the confirmed name — so two rows can converge on one business only after
// they have both been researched. Catch it here, at run time, rather than at
// browse time.
{
  const norm = (u) => (u || '').toLowerCase().trim()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  const live = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('providers')
      .select('name, slug, website, status').range(from, from + 999);
    if (error) break;
    live.push(...data.filter((p) => p.status !== 'merged'));
    if (data.length < 1000) break;
  }
  const groups = new Map();
  for (const p of live) {
    const key = `${p.name.toLowerCase().trim()}::${norm(p.website)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const collided = [...groups.values()].filter((g) => g.length > 1);
  if (collided.length) {
    console.warn(`\n⚠  WARNING: ${collided.length} confirmed_name + website collision(s) — these are the same business under multiple rows:`);
    for (const g of collided) {
      console.warn(`   "${g[0].name}" (${g[0].website || 'no site'})`);
      for (const p of g) console.warn(`      · ${p.slug}`);
    }
    console.warn(`   Resolve with: node src/dedup-merge.js --dry-run\n`);
  }
}

const { data: runs } = await supabase.from('research_runs').select('input_tokens,output_tokens,cache_read_tokens,searches_used');
const t = (runs || []).reduce((a, r) => ({
  in: a.in + r.input_tokens, out: a.out + r.output_tokens,
  cache: a.cache + r.cache_read_tokens, s: a.s + r.searches_used
}), { in: 0, out: 0, cache: 0, s: 0 });
console.log(`\nDone. Cumulative: ${t.s} searches, ${t.in} in / ${t.out} out / ${t.cache} cached tokens.`);
