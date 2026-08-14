// NOLA Archive — Stage 3a: experience taxonomy clustering
//
// Derives the experience taxonomy from the archive's own facts. The seed
// vocabulary in docs/stage3-seed-vocabulary.md is offered as candidate
// language only — clusters that diverge from it are a finding, not an error.
//
// Three passes, checkpointed to .stage3-cache/ so an interrupted run resumes:
//   1. map       (sonnet) 399 businesses -> compact capability summaries
//   2. cluster   (opus)   summaries, in category batches -> candidate clusters
//   3. reconcile (opus)   all candidates -> merged, deduped, ranked taxonomy
//
// A naive dump of all 7,668 facets is ~289k tokens; pass 1 compresses that to
// roughly 50k so the clustering pass can reason over the whole universe.
//
// Short aliases (p12 / f3401) stand in for UUIDs throughout: 36-char ids for
// 7,668 facets would cost ~75k tokens on their own.
//
// Usage:  node src/cluster-experiences.js              (resume from cache)
//         node src/cluster-experiences.js --fresh      (ignore cache)
//         node src/cluster-experiences.js --dry-run    (build passes, skip DB write)

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const MAP_MODEL = 'claude-sonnet-4-6';
const CLUSTER_MODEL = 'claude-opus-4-8';
const CACHE = '.stage3-cache';
const MAX_CLUSTERS = 80;

const FRESH = process.argv.includes('--fresh');
const DRY = process.argv.includes('--dry-run');
// --limit N: smoke-test the whole chain on a slice before spending on 399
const LIMIT_ARG = process.argv.indexOf('--limit');
const LIMIT = LIMIT_ARG > -1 ? parseInt(process.argv[LIMIT_ARG + 1], 10) : null;

const need = (k) => {
  if (!process.env[k]) { console.error(`Missing env var ${k}`); process.exit(1); }
  return process.env[k];
};
const anthropic = new Anthropic({ apiKey: need('ANTHROPIC_API_KEY') });
const supabase = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'));

const usage = { in: 0, out: 0, cache: 0, calls: 0, byModel: {} };
const PRICE = {
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-opus-4-8': { in: 5, out: 25 }
};

const fail = (ctx, e) => {
  const d = [e?.code, e?.message, e?.details, e?.hint].filter(Boolean).join(' | ');
  throw new Error(`${ctx}: ${d || JSON.stringify(e)}`);
};

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

// ---------- cache ----------
fs.mkdirSync(CACHE, { recursive: true });
const cachePath = (n) => path.join(CACHE, `${n}.json`);
const readCache = (n) => {
  if (FRESH || !fs.existsSync(cachePath(n))) return null;
  try { return JSON.parse(fs.readFileSync(cachePath(n), 'utf8')); } catch { return null; }
};
const writeCache = (n, v) => fs.writeFileSync(cachePath(n), JSON.stringify(v, null, 2));

// ---------- JSON extraction (model may append prose) ----------
function extractJson(text, open = '{', close = '}') {
  const s = text.replace(/```json|```/g, '').trim();
  const start = s.indexOf(open);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { if (inStr) esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

async function callModel({ model, system, user, maxTokens = 16000, opus = false, label }) {
  const params = {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }]
  };
  // Opus 4.8 runs WITHOUT thinking unless adaptive is set explicitly.
  if (opus) {
    params.thinking = { type: 'adaptive' };
    params.output_config = { effort: 'high' };
  }

  const stream = await anthropic.messages.stream(params);
  const msg = await stream.finalMessage();

  const u = msg.usage || {};
  usage.in += u.input_tokens || 0;
  usage.out += u.output_tokens || 0;
  usage.cache += u.cache_read_input_tokens || 0;
  usage.calls++;
  const m = (usage.byModel[model] ||= { in: 0, out: 0, cache: 0, calls: 0 });
  m.in += u.input_tokens || 0; m.out += u.output_tokens || 0;
  m.cache += u.cache_read_input_tokens || 0; m.calls++;

  if (msg.stop_reason === 'max_tokens') {
    throw new Error(`${label}: truncated at max_tokens (${maxTokens})`);
  }
  return (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// ---------- load archive ----------
async function all(table, select) {
  const out = []; const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + size - 1);
    if (error) fail(`Loading ${table}`, error);
    out.push(...data); if (data.length < size) break;
  }
  return out;
}

console.log('Loading archive…');
const providersAll = await all('providers', 'id,name,slug,status,categories,discovered_from');
let providers = providersAll.filter((p) => p.status === 'complete');
if (LIMIT) {
  // spread the slice across categories so a smoke test still exercises batching
  const seen = new Map();
  providers = providers.filter((p) => {
    const c = p.discovered_from === 'pilot_seed' ? 'seed' : p.discovered_from;
    const n = seen.get(c) || 0;
    if (n >= 2) return false;
    seen.set(c, n + 1); return true;
  }).slice(0, LIMIT);
  console.log(`--limit ${LIMIT}: using ${providers.length} businesses`);
}
const facetsAll = await all('facets', 'id,provider_id,facet_type,label,value,value_numeric,unit,confidence');
const druns = await all('discovery_runs', 'query,category');
const catOfQuery = Object.fromEntries(druns.map((r) => [r.query, r.category]));

// identity facets (address, phone, founding year) carry no clustering signal
const CLUSTER_FACETS = facetsAll.filter((f) => f.facet_type !== 'identity');

// short aliases
const pAlias = new Map(), pById = new Map();
providers.forEach((p, i) => { pAlias.set(p.id, `p${i + 1}`); pById.set(`p${i + 1}`, p); });
const fAlias = new Map(), fById = new Map();
CLUSTER_FACETS.forEach((f, i) => { fAlias.set(f.id, `f${i + 1}`); fById.set(`f${i + 1}`, f); });

const facetsByProvider = new Map();
for (const f of CLUSTER_FACETS) {
  if (!pAlias.has(f.provider_id)) continue;
  if (!facetsByProvider.has(f.provider_id)) facetsByProvider.set(f.provider_id, []);
  facetsByProvider.get(f.provider_id).push(f);
}

const categoryOf = (p) =>
  p.discovered_from === 'pilot_seed' ? (p.categories?.[0] || 'other') : (catOfQuery[p.discovered_from] || 'other');

console.log(`${providers.length} complete businesses · ${CLUSTER_FACETS.length} clusterable facets (identity excluded)\n`);

// ============================================================
// PASS 1 — map
// ============================================================
const PASS1_SYSTEM = `You compress a business's sourced facts into a compact capability summary for a clustering pass over New Orleans event and experience providers.

You receive several businesses. For EACH, return one summary object.

RULES
1. Describe only what the facts state. Do not infer capabilities that are not evidenced. If a business's facts are thin, say so with a short summary — do not pad.
2. "capabilities" are the things a corporate group planner could actually book or use. Phrase them as short noun phrases, lowercase.
3. Facts marked [RELATED PROPERTY] describe a DIFFERENT, affiliated property. Never attribute them to this business as its own room or capacity. If they matter, express it as a capability such as "operates affiliated venues".
4. "evidence" is 4-12 facet ids that best support the capabilities you listed. Prefer capacity, group_size, pricing_signal, venue_format, booking_constraint and service facts over colour.
5. The business name is INTERNAL ONLY — it is context for you, never published downstream.

Return ONLY a JSON array, no prose:
[
  {
    "p": "p12",
    "summary": "one sentence, factual",
    "capabilities": ["private dining buyout", "second line parade"],
    "capacity": "short phrase or null",
    "group_size": "short phrase or null",
    "formats": ["seated dinner", "reception"],
    "evidence": ["f101", "f102"]
  }
]`;

function providerBlock(p) {
  const fs_ = facetsByProvider.get(p.id) || [];
  const lines = fs_.map((f) => {
    const rel = f.facet_type === 'related_property' ? '[RELATED PROPERTY] ' : '';
    const num = f.value_numeric != null ? ` (${f.value_numeric}${f.unit ? ' ' + f.unit : ''})` : '';
    return `  ${fAlias.get(f.id)} ${f.facet_type}/${f.label}: ${rel}${f.value}${num}`;
  });
  return `### ${pAlias.get(p.id)} — ${p.name} [INTERNAL ONLY]\ncategories: ${(p.categories || []).join(', ')}\n${lines.join('\n')}`;
}

async function pass1() {
  const cached = readCache('pass1');
  if (cached) { console.log(`PASS 1 — cached (${cached.length} summaries)\n`); return cached; }

  const BATCH = 8;
  const batches = [];
  for (let i = 0; i < providers.length; i += BATCH) batches.push(providers.slice(i, i + BATCH));

  console.log(`PASS 1 (map, ${MAP_MODEL}) — ${providers.length} businesses in ${batches.length} batches`);
  const summaries = [];
  for (let i = 0; i < batches.length; i++) {
    const text = await callModel({
      model: MAP_MODEL,
      system: PASS1_SYSTEM,
      user: batches[i].map(providerBlock).join('\n\n'),
      maxTokens: 8000,
      label: `pass1 batch ${i + 1}`
    });
    const json = extractJson(text, '[', ']');
    if (!json) throw new Error(`pass1 batch ${i + 1}: no JSON array in output`);
    const arr = JSON.parse(json);
    summaries.push(...arr);
    process.stdout.write(`\r  batch ${i + 1}/${batches.length} · ${summaries.length} summaries`);
  }
  console.log('');
  writeCache('pass1', summaries);
  console.log(`  wrote ${summaries.length} summaries\n`);
  return summaries;
}

// ============================================================
// PASS 2 — cluster
// ============================================================
const SEED_VOCAB = fs.existsSync('docs/stage3-seed-vocabulary.md')
  ? fs.readFileSync('docs/stage3-seed-vocabulary.md', 'utf8')
  : '(seed vocabulary file not found)';

const PASS2_SYSTEM = `You derive an EXPERIENCE TAXONOMY from an archive of New Orleans event and experience providers, for a destination management company answering corporate group planners.

A cluster is a bookable experience or capability that a planner would search for and that multiple businesses in this market can supply. It is NOT a business category and NOT a facet type.

SEED VOCABULARY (candidate language only)
${SEED_VOCAB}

The seed is a starting point so your names land in language a DMC recognises. It is NOT binding. Merge, split, rename, or ignore its branches wherever the evidence disagrees — divergence from the seed is a finding, and you should let the facts win.

ABSOLUTE RULES
1. EVIDENCE ONLY. Every cluster must be grounded in the summaries you were given. Never invent a capability this market has not demonstrated.
2. Propose a cluster only when 3 OR MORE businesses support it. The one exception: a capability that is singular but genuinely strong and clearly planner-relevant — include it and set "thin": true.
3. Every member must cite evidence: the facet ids from that business's summary that justify membership.
4. "group_size_range" must be supported by the evidence, not assumed. Use null if the facts do not say.
5. Clusters must be DISTINCT from one another. If two ideas would answer the same planner question, they are one cluster.
6. Prefer clusters a planner would actually ask for ("rooftop receptions for 150", "hands-on Creole cooking for teams") over abstract groupings ("food-related businesses").

Return ONLY a JSON object, no prose:
{
  "clusters": [
    {
      "name": "Human-readable cluster name",
      "slug": "kebab-case-slug",
      "description": "2-3 sentences on what this experience is and what it delivers for a group.",
      "planner_questions": ["The question a planner would ask that this answers"],
      "group_size_range": "e.g. 20-300 guests, or null",
      "thin": false,
      "rationale": "one line: why this cluster, and what evidence depth supports it",
      "members": [ { "p": "p12", "evidence": ["f101","f102"] } ]
    }
  ]
}`;

// Related categories share a batch so cross-category clusters can form;
// pass 3 reconciles anything that still splits across batches.
const BATCH_GROUPS = [
  { name: 'venues', cats: ['venue'] },
  { name: 'dining + catering', cats: ['group_dining', 'catering'] },
  { name: 'activities + entertainment', cats: ['activity', 'entertainment'] },
  { name: 'logistics', cats: ['transportation', 'staffing'] },
  { name: 'production + decor + rentals', cats: ['production', 'decor', 'event_rentals'] },
  { name: 'photo + gifting + other', cats: ['photography', 'gifting', 'other'] }
];

const compact = (s) => {
  const parts = [
    `${s.p}: ${s.summary}`,
    s.capabilities?.length ? `  can: ${s.capabilities.join('; ')}` : null,
    s.capacity ? `  capacity: ${s.capacity}` : null,
    s.group_size ? `  groups: ${s.group_size}` : null,
    s.formats?.length ? `  formats: ${s.formats.join(', ')}` : null,
    s.evidence?.length ? `  ev: ${s.evidence.join(',')}` : null
  ];
  return parts.filter(Boolean).join('\n');
};

async function pass2(summaries) {
  const cached = readCache('pass2');
  if (cached) { console.log(`PASS 2 — cached (${cached.length} candidate clusters)\n`); return cached; }

  const byAlias = Object.fromEntries(summaries.map((s) => [s.p, s]));
  const assigned = new Set();
  const batches = [];
  for (const g of BATCH_GROUPS) {
    const members = providers.filter((p) => g.cats.includes(categoryOf(p)));
    const rows = members.map((p) => byAlias[pAlias.get(p.id)]).filter(Boolean);
    rows.forEach((r) => assigned.add(r.p));
    if (rows.length) batches.push({ name: g.name, rows });
  }
  const leftovers = summaries.filter((s) => !assigned.has(s.p));
  if (leftovers.length) batches.push({ name: 'uncategorised', rows: leftovers });

  console.log(`PASS 2 (cluster, ${CLUSTER_MODEL}) — ${batches.length} batches`);
  const clusters = [];
  for (const b of batches) {
    const text = await callModel({
      model: CLUSTER_MODEL,
      opus: true,
      system: PASS2_SYSTEM,
      user: `Batch: ${b.name} (${b.rows.length} businesses)\n\n${b.rows.map(compact).join('\n\n')}`,
      maxTokens: 32000,
      label: `pass2 ${b.name}`
    });
    const json = extractJson(text, '{', '}');
    if (!json) throw new Error(`pass2 ${b.name}: no JSON object in output`);
    const parsed = JSON.parse(json);
    const got = parsed.clusters || [];
    got.forEach((c) => { c._batch = b.name; });
    clusters.push(...got);
    console.log(`  ${b.name.padEnd(30)} ${b.rows.length} businesses -> ${got.length} clusters`);
  }
  writeCache('pass2', clusters);
  console.log(`  ${clusters.length} candidate clusters\n`);
  return clusters;
}

// ============================================================
// PASS 3 — reconcile
// ============================================================
const PASS3_SYSTEM = `You are finalising an experience taxonomy for a New Orleans destination management company. You receive candidate clusters produced independently from separate category batches, so there ARE near-duplicates and overlaps across batches.

Your job:
1. MERGE near-duplicates. Two clusters that answer the same planner question are one cluster. When merging, union their members and keep the clearest name and description.
2. ENFORCE distinct slugs. Every slug must be unique, kebab-case, and descriptive.
3. RANK every surviving cluster by (a) depth of evidence — how many businesses support it and how substantive that support is — and (b) likely planner-query value, i.e. how often a corporate group planner would actually ask for it. State the ranking basis in "rationale".
4. Keep at most ${MAX_CLUSTERS} clusters in "clusters". Anything real but lower value goes in "parked" with a one-line reason — do not silently drop it.
5. Preserve every member and its evidence ids through a merge. Never fabricate members or evidence.
6. Keep "thin": true on any cluster whose support is singular-but-strong.

Return ONLY a JSON object, no prose:
{
  "clusters": [
    {
      "rank": 1,
      "name": "...", "slug": "...", "description": "...",
      "planner_questions": ["..."],
      "group_size_range": "... or null",
      "thin": false,
      "rationale": "why it ranks here — evidence depth and planner value",
      "members": [ { "p": "p12", "evidence": ["f101"] } ]
    }
  ],
  "parked": [ { "name": "...", "slug": "...", "reason": "...", "member_count": 3 } ],
  "seed_divergence": "2-4 sentences: where this taxonomy departs from the seed vocabulary and why the evidence pushed it there."
}`;

async function pass3(clusters) {
  const cached = readCache('pass3');
  if (cached) { console.log('PASS 3 — cached\n'); return cached; }

  console.log(`PASS 3 (reconcile, ${CLUSTER_MODEL}) — ${clusters.length} candidates`);
  const payload = clusters.map((c) => ({
    batch: c._batch, name: c.name, slug: c.slug, description: c.description,
    planner_questions: c.planner_questions, group_size_range: c.group_size_range,
    thin: c.thin, rationale: c.rationale, members: c.members
  }));

  const text = await callModel({
    model: CLUSTER_MODEL,
    opus: true,
    system: PASS3_SYSTEM,
    user: `Candidate clusters (${clusters.length}) from ${new Set(clusters.map((c) => c._batch)).size} batches:\n\n${JSON.stringify(payload)}`,
    maxTokens: 64000,
    label: 'pass3'
  });
  const json = extractJson(text, '{', '}');
  if (!json) throw new Error('pass3: no JSON object in output');
  const parsed = JSON.parse(json);
  writeCache('pass3', parsed);
  console.log(`  ${parsed.clusters?.length || 0} final clusters · ${parsed.parked?.length || 0} parked\n`);
  return parsed;
}

// ============================================================
// WRITE
// ============================================================
async function write(final) {
  const clusters = final.clusters || [];
  console.log('Writing experiences (wipe and reload)…');

  // wipe: experience_facets cascades from experiences
  const { data: existing } = await supabase.from('experiences').select('id');
  for (const e of existing || []) {
    const { error } = await supabase.from('experiences').delete().eq('id', e.id);
    if (error) fail('Wiping experiences', error);
  }

  const seenSlug = new Set();
  let linkTotal = 0, droppedEvidence = 0;

  for (const c of clusters) {
    let slug = slugify(c.slug || c.name);
    if (seenSlug.has(slug)) { let n = 2; while (seenSlug.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }
    seenSlug.add(slug);

    const memberNames = (c.members || [])
      .map((m) => pById.get(m.p)?.name).filter(Boolean);

    const notes = [
      `RANK ${c.rank ?? '?'}${c.thin ? ' · THIN EVIDENCE' : ''}`,
      c.planner_questions?.length ? `PLANNER QUESTIONS:\n- ${c.planner_questions.join('\n- ')}` : null,
      c.group_size_range ? `GROUP SIZE: ${c.group_size_range}` : null,
      c.rationale ? `RANKING RATIONALE: ${c.rationale}` : null,
      `MEMBERS (${memberNames.length}): ${memberNames.join(', ')}`
    ].filter(Boolean).join('\n\n');

    const { data: row, error } = await supabase.from('experiences')
      .insert({ name: c.name, slug, description: c.description || null, cluster_notes: notes })
      .select().single();
    if (error) fail(`Inserting experience ${slug}`, error);

    // resolve evidence aliases -> facet uuids, dedupe (PK is composite)
    const facetIds = new Set();
    for (const m of c.members || []) {
      for (const alias of m.evidence || []) {
        const f = fById.get(alias);
        if (f) facetIds.add(f.id); else droppedEvidence++;
      }
    }
    const links = [...facetIds].map((facet_id) => ({ experience_id: row.id, facet_id }));
    for (let i = 0; i < links.length; i += 500) {
      const { error: lErr } = await supabase.from('experience_facets').insert(links.slice(i, i + 500));
      if (lErr) fail(`Linking facets for ${slug}`, lErr);
    }
    linkTotal += links.length;
  }

  console.log(`  ${clusters.length} experiences · ${linkTotal} facet links` +
    (droppedEvidence ? ` · ${droppedEvidence} unresolvable evidence ids skipped` : ''));
  return { linkTotal, droppedEvidence };
}

// ============================================================
// MAIN
// ============================================================
const summaries = await pass1();
const candidates = await pass2(summaries);
const final = await pass3(candidates);

let writeStats = null;
if (DRY) console.log('--dry-run — skipping database write\n');
else writeStats = await write(final);

// ---------- report ----------
const cost = Object.entries(usage.byModel).reduce((a, [model, u]) => {
  const p = PRICE[model] || { in: 0, out: 0 };
  return a + (u.in / 1e6) * p.in + (u.out / 1e6) * p.out + (u.cache / 1e6) * (p.in * 0.1);
}, 0);

console.log('\n=== STAGE 3A SUMMARY ===');
console.log(`clusters : ${final.clusters?.length || 0}`);
console.log(`parked   : ${final.parked?.length || 0}`);
console.log(`thin     : ${(final.clusters || []).filter((c) => c.thin).length}`);
if (writeStats) console.log(`links    : ${writeStats.linkTotal}`);
console.log('\ncost by model:');
for (const [model, u] of Object.entries(usage.byModel)) {
  const p = PRICE[model] || { in: 0, out: 0 };
  const c = (u.in / 1e6) * p.in + (u.out / 1e6) * p.out + (u.cache / 1e6) * (p.in * 0.1);
  console.log(`  ${model.padEnd(20)} ${String(u.calls).padStart(3)} calls  ${u.in} in / ${u.out} out / ${u.cache} cached  $${c.toFixed(2)}`);
}
console.log(`TOTAL: $${cost.toFixed(2)} over ${usage.calls} calls`);

writeCache('report', {
  clusters: final.clusters, parked: final.parked,
  seed_divergence: final.seed_divergence, usage, cost
});
console.log(`\nFull result cached in ${CACHE}/ — re-run is idempotent (wipe and reload).`);
