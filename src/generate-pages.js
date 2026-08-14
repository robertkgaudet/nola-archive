// NOLA Archive — Stage 3b: answer page generation
//
// Writes one answer page per experience cluster, grounded ONLY in the archive's
// own facts. The generator never sees provider names and never works from model
// memory: the payload it receives is the cluster's own description, its planner
// questions, and the facet values linked to it as evidence.
//
// Two gates run after generation and their verdicts are stored on the page:
//   1. shield  — every archive provider name checked across every field
//   2. claims  — every claim_map facet id must exist AND belong to this cluster
// Failures are recorded and the page stays draft. Nothing is auto-fixed.
//
// Usage:
//   node src/generate-pages.js --sample     the 5 review clusters
//   node src/generate-pages.js --all        every cluster
//   node src/generate-pages.js --slug <s>   one cluster
//   node src/generate-pages.js --dry-run    generate + gate, skip the DB write

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { shieldCheck } from './shield-gate.js';

const MODEL = 'claude-sonnet-4-6';
const CACHE = '.stage3b-cache';

const SAMPLE_SLUGS = [
  'second-line-parade-production',
  'restaurant-private-dining-rooms',
  'charter-bus-motorcoach-transport',
  'rooftop-balcony-receptions',
  'museum-attraction-buyouts'
];

const DRY = process.argv.includes('--dry-run');
const arg = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };

const need = (k) => {
  if (!process.env[k]) { console.error(`Missing env var ${k}`); process.exit(1); }
  return process.env[k];
};
const anthropic = new Anthropic({ apiKey: need('ANTHROPIC_API_KEY') });
const supabase = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'));

const usage = { in: 0, out: 0, cache: 0, calls: 0 };
const PRICE = { in: 3, out: 15 };

fs.mkdirSync(CACHE, { recursive: true });

const fail = (ctx, e) => {
  const d = [e?.code, e?.message, e?.details, e?.hint].filter(Boolean).join(' | ');
  throw new Error(`${ctx}: ${d || JSON.stringify(e)}`);
};

function extractJson(text) {
  const s = text.replace(/```json|```/g, '').trim();
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
  return null;
}

// ---------- system prompt (static, cached) ----------
const SYSTEM = `You write answer pages for NOLA DMC, a locally woman-owned destination management company in New Orleans. Each page answers one question a corporate group planner actually asks.

You are given a GROUNDING PAYLOAD: an experience cluster, the planner questions it answers, aggregate statistics, and a list of evidence facts drawn from a research archive. You write the page from that payload and from nothing else.

ABSOLUTE RULES
1. FACTS ONLY FROM THE PAYLOAD. Never add a capacity, price, duration, neighbourhood, rule, or logistic that is not in the evidence list. If the payload does not support a detail, leave it out. Never fill a gap from general knowledge about New Orleans.
2. NEVER NAME A BUSINESS, VENUE, RESTAURANT, HOTEL, BAND, OPERATOR, OR VENDOR. Not one, ever — not even as an example, and not even if a name appears inside an evidence value. Write about what the market offers, not who offers it. Proper nouns for neighbourhoods and public landmarks (French Quarter, Warehouse District, Mississippi River, Bourbon Street) are fine.
3. Facts marked confidence "low" MUST NOT be used at all.
4. Use aggregate counts ONLY when they match the member_count given in the payload. Do not invent "dozens of" or "more than 30" if the payload says 19.
5. Every substantive claim in the page must appear in claim_map, mapped to the facet ids that support it. If you cannot cite it, do not write it.
6. End body_md with the exact token {{CTA_RFP}} on its own final line. Write no call-to-action sentence of your own around it.

VOICE — this is half the job
The page must sound like it belongs on noladmc.com, not like a directory listing or a spec sheet. Her voice: warm, confident, second person, locally rooted, emotionally intelligent. She writes about experiences people "feel, remember, and talk about" — about connecting people "to each other, to your brand, and to New Orleans in a way that actually means something." She promises strategy plus authentic New Orleans culture plus flawless execution. She uses em-dashes and speaks directly to the planner.

FACT DENSITY — this is the other half
The body must carry specific, verifiable operational detail: real capacities, real group-size ranges, real formats, real booking and seasonal constraints. This is what makes the page citable by AI answer engines and useful to a planner comparing options.

Neither job may be sacrificed for the other. Open with voice and get to the answer fast. Deliver the operational substance in the body, written in her voice rather than as bullets of specs. Never pad with adjectives in place of facts, and never let the page collapse into a dry list.

WRITING GUIDANCE
- title: the planner question this page answers, as a natural headline.
- direct_answer: 60-80 words. Answer the question outright in the first sentence — no throat-clearing. Warm, but concrete enough to stand alone as a featured snippet.
- body_md: markdown, roughly 400-650 words. Use ## subheadings. Cover what the experience is, the range of what is possible (capacities, formats, group sizes), and the practical realities a planner needs to know (booking constraints, timing, logistics). Prose, not bullet-dumps — at most one short list where a list genuinely helps.
- faq: 3-5 entries. Real planner questions, answered from the evidence. These are where precise numbers belong.
- related_slugs: 2-3 slugs from the sibling list provided.
- meta_description: max 155 characters, natural, includes the core answer.

Return ONLY a JSON object:
{
  "title": "...",
  "direct_answer": "...",
  "body_md": "...",
  "faq": [{"q": "...", "a": "..."}],
  "related_slugs": ["..."],
  "meta_description": "...",
  "claim_map": [{"claim": "the specific claim as written", "facet_ids": ["e12"]}]
}`;

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
const experiences = await all('experiences', 'id,name,slug,description,cluster_notes');
const links = await all('experience_facets', 'experience_id,facet_id');
const facets = await all('facets', 'id,provider_id,facet_type,label,value,value_numeric,unit,confidence');
const providers = await all('providers', 'id,name,status');

const facetById = new Map(facets.map((f) => [f.id, f]));
// Blocklist: every provider name in the archive. Not the confidential Stage 4
// vendor list — that stays at SHIELD_BLOCKLIST_PATH and is never loaded here.
const BLOCKLIST = providers.filter((p) => p.status !== 'merged').map((p) => p.name);
console.log(`${experiences.length} clusters · ${BLOCKLIST.length} names in the shield blocklist\n`);

const notesField = (notes, label) => {
  const m = (notes || '').match(new RegExp(`${label}:\\s*(.+)`));
  return m ? m[1].trim() : null;
};

function buildPayload(exp) {
  const ids = links.filter((l) => l.experience_id === exp.id).map((l) => l.facet_id);
  const evidence = ids.map((i) => facetById.get(i)).filter(Boolean)
    // rule 3 is enforced here as well as in the prompt: low-confidence facts
    // are removed from the payload so they cannot be used even by accident
    .filter((f) => f.confidence !== 'low');

  const shortId = new Map();
  evidence.forEach((f, i) => shortId.set(`e${i + 1}`, f.id));

  const memberCount = new Set(evidence.map((f) => f.provider_id)).size;
  const questions = ((exp.cluster_notes || '').match(/PLANNER QUESTIONS:\n([\s\S]*?)(\n\n|$)/) || [])[1];

  const siblings = experiences.filter((e) => e.id !== exp.id).map((e) => e.slug);

  const lines = evidence.map((f, i) => {
    const num = f.value_numeric != null ? ` (${f.value_numeric}${f.unit ? ' ' + f.unit : ''})` : '';
    return `e${i + 1} [${f.facet_type}, ${f.confidence}] ${f.value}${num}`;
  });

  const user = `EXPERIENCE CLUSTER
name: ${exp.name}
description: ${exp.description || ''}

PLANNER QUESTIONS THIS PAGE MUST ANSWER
${questions ? questions.trim() : '(none recorded)'}

AGGREGATE STATISTICS (these numbers are true; do not contradict or inflate them)
businesses in this cluster: ${memberCount}
group size range supported by the evidence: ${notesField(exp.cluster_notes, 'GROUP SIZE') || 'not established'}

EVIDENCE FACTS — the only facts you may use
${lines.join('\n')}

SIBLING PAGE SLUGS (choose 2-3 for related_slugs)
${siblings.join(', ')}`;

  return { user, shortId, evidence, memberCount };
}

// ---------- gates ----------
function runShield(page, blocklist) {
  const fields = {
    title: page.title,
    slug: page.slug,
    direct_answer: page.direct_answer,
    body_md: page.body_md,
    meta_description: page.meta_description,
    faq: (page.faq || []).map((x) => `${x.q} ${x.a}`).join(' '),
    related_slugs: (page.related_slugs || []).join(' '),
    claim_map: (page.claim_map || []).map((c) => c.claim).join(' ')
  };
  const hits = shieldCheck(fields, blocklist);

  // shieldCheck flags a single distinctive token, which is right for the
  // confidential Stage 4 list but noisy against 409 archive names full of
  // common nouns ("Plates Restaurant & Bar" would flag any page saying
  // "restaurant"). Separate the two so a real leak is not buried.
  const exact = hits.filter((h) => h.match === 'exact_phrase');
  return { hits, exact };
}

function runClaimAudit(page, shortId, evidence) {
  const clusterFacetIds = new Set(evidence.map((f) => f.id));
  const issues = [];
  for (const c of page.claim_map || []) {
    for (const sid of c.facet_ids || []) {
      const real = shortId.get(sid);
      if (!real) { issues.push({ claim: c.claim, id: sid, problem: 'unknown facet id' }); continue; }
      if (!clusterFacetIds.has(real)) issues.push({ claim: c.claim, id: sid, problem: 'facet not in this cluster' });
    }
    if (!(c.facet_ids || []).length) issues.push({ claim: c.claim, id: null, problem: 'claim cites no evidence' });
  }
  return issues;
}

// ---------- generate one ----------
async function generate(exp) {
  console.log(`\n→ ${exp.name}`);
  const { user, shortId, evidence, memberCount } = buildPayload(exp);

  const stream = await anthropic.messages.stream({
    model: MODEL,
    max_tokens: 8000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }]
  });
  const msg = await stream.finalMessage();

  const u = msg.usage || {};
  usage.in += u.input_tokens || 0; usage.out += u.output_tokens || 0;
  usage.cache += u.cache_read_input_tokens || 0; usage.calls++;

  if (msg.stop_reason === 'max_tokens') throw new Error('truncated at max_tokens');

  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const json = extractJson(text);
  if (!json) throw new Error('no JSON object in output');
  const page = JSON.parse(json);
  page.slug = exp.slug;

  // gates
  const shield = runShield(page, BLOCKLIST);
  const claimIssues = runClaimAudit(page, shortId, evidence);

  page._gates = {
    shield_status: shield.exact.length ? 'flagged' : 'clean',
    shield_hits: shield.exact,
    shield_token_hits: shield.hits.filter((h) => h.match !== 'exact_phrase'),
    claim_audit_status: claimIssues.length ? 'fail' : 'pass',
    claim_audit_issues: claimIssues
  };
  page._meta = {
    experience_id: exp.id,
    member_count: memberCount,
    evidence_count: evidence.length,
    usage: { in: u.input_tokens || 0, out: u.output_tokens || 0, cache: u.cache_read_input_tokens || 0 }
  };
  // short-id -> real uuid, so the browser can resolve claims to facets
  page._claim_resolved = (page.claim_map || []).map((c) => ({
    claim: c.claim,
    facet_ids: (c.facet_ids || []).map((s) => shortId.get(s)).filter(Boolean)
  }));

  console.log(`  ${page.body_md.split(/\s+/).length} words · shield ${page._gates.shield_status} · claims ${page._gates.claim_audit_status} (${(page.claim_map || []).length} mapped)`);
  if (!page.body_md.includes('{{CTA_RFP}}')) console.log('  !! missing {{CTA_RFP}} token');
  return page;
}

// ---------- write ----------
async function writePage(page) {
  const g = page._gates;
  const row = {
    experience_id: page._meta.experience_id,
    slug: page.slug,
    title: page.title,
    direct_answer: page.direct_answer,
    body_md: page.body_md,
    faq: page.faq,
    related_slugs: page.related_slugs,
    meta_description: page.meta_description,
    claim_map: page._claim_resolved,
    status: 'draft',
    shield_status: g.shield_status,
    shield_hits: g.shield_hits,
    claim_audit_status: g.claim_audit_status,
    claim_audit_issues: g.claim_audit_issues,
    model: MODEL,
    input_tokens: page._meta.usage.in,
    output_tokens: page._meta.usage.out,
    cache_read_tokens: page._meta.usage.cache,
    updated_at: new Date().toISOString()
  };
  await supabase.from('pages').delete().eq('slug', page.slug);
  const { error } = await supabase.from('pages').insert(row);
  if (error) fail(`Writing page ${page.slug}`, error);
}

// ---------- main ----------
let targets;
if (arg('--slug')) targets = experiences.filter((e) => e.slug === arg('--slug'));
else if (process.argv.includes('--all')) targets = experiences;
else targets = SAMPLE_SLUGS.map((s) => experiences.find((e) => e.slug === s)).filter(Boolean);

if (!targets.length) { console.error('No matching clusters.'); process.exit(1); }
console.log(`Generating ${targets.length} page(s) with ${MODEL}`);

const pages = [];
for (const exp of targets) {
  try { pages.push(await generate(exp)); }
  catch (e) { console.error(`  ✗ ${exp.slug}: ${e.message}`); }
}

fs.writeFileSync(path.join(CACHE, 'pages.json'), JSON.stringify(pages, null, 2));

if (DRY) {
  console.log('\n--dry-run — not written to the database');
} else {
  const probe = await supabase.from('pages').select('id').limit(1);
  if (probe.error) {
    console.log(`\n!! pages table unavailable (${probe.error.code}) — results cached in ${CACHE}/pages.json`);
    console.log('   Run sql/migrations/005-pages.sql, then re-run to persist.');
  } else {
    for (const p of pages) await writePage(p);
    console.log(`\nWrote ${pages.length} page(s) to the database.`);
  }
}

const cost = (usage.in / 1e6) * PRICE.in + (usage.out / 1e6) * PRICE.out + (usage.cache / 1e6) * PRICE.in * 0.1;
console.log('\n=== SUMMARY ===');
console.log(`pages          : ${pages.length}`);
console.log(`shield flagged : ${pages.filter((p) => p._gates.shield_status === 'flagged').length}`);
console.log(`claim failures : ${pages.filter((p) => p._gates.claim_audit_status === 'fail').length}`);
console.log(`tokens         : ${usage.in} in / ${usage.out} out / ${usage.cache} cached`);
console.log(`cost           : $${cost.toFixed(3)} over ${usage.calls} calls`);
