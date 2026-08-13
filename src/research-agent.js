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

const need = (k) => {
  if (!process.env[k]) { console.error(`Missing env var ${k} — see .env.example`); process.exit(1); }
  return process.env[k];
};

const anthropic = new Anthropic({ apiKey: need('ANTHROPIC_API_KEY') });
const supabase = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'));

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

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

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: [{ type: 'text', text: EXTRACTION_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES }],
      messages: [{
        role: 'user',
        content: `Research this provider and return the JSON object.\nName: ${provider.name}\nCity: ${provider.city || 'New Orleans'}\nExpected categories (verify, don't assume): ${(provider.categories || []).join(', ')}`
      }]
    });

    const usage = response.usage || {};
    const searchCount = (response.content || []).filter((b) => b.type === 'server_tool_use').length;
    const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const jsonStr = text.replace(/```json|```/g, '').trim();
    const start = jsonStr.indexOf('{');
    const end = jsonStr.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object in model output');
    const data = JSON.parse(jsonStr.slice(start, end + 1));

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
    await finishRun(run.id, 'failed', 0, {}, err.message);
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

// ---------- main ----------
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > -1 ? parseInt(process.argv[limitArg + 1], 10) : 1000;

await seedIfEmpty();
// re-queue anything stuck mid-run from a previous interrupted session
await supabase.from('providers').update({ status: 'pending' }).eq('status', 'researching');

const { data: pending, error } = await supabase.from('providers')
  .select('*').eq('status', 'pending').order('created_at').limit(limit);
if (error) fail('Fetching pending providers failed', error);
console.log(`${pending.length} provider(s) pending.`);

for (const p of pending) {
  await researchProvider(p);
  await new Promise((r) => setTimeout(r, 1500)); // gentle pacing
}

const { data: runs } = await supabase.from('research_runs').select('input_tokens,output_tokens,cache_read_tokens,searches_used');
const t = (runs || []).reduce((a, r) => ({
  in: a.in + r.input_tokens, out: a.out + r.output_tokens,
  cache: a.cache + r.cache_read_tokens, s: a.s + r.searches_used
}), { in: 0, out: 0, cache: 0, s: 0 });
console.log(`\nDone. Cumulative: ${t.s} searches, ${t.in} in / ${t.out} out / ${t.cache} cached tokens.`);
