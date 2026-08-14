// NOLA Archive — post-research dedup merge
//
// Discovery deduped on the SEEDED name, but the research agent overwrites
// `name` with the confirmed name. Two rows seeded under different names can
// therefore converge on the same real business after dedup has already run.
// This folds those rows together.
//
// A group is only merged when every row shares the same normalized website.
// Same name + different site means two real businesses, and is left alone.
//
// Losers become tombstones: status 'merged', name intact, merged_into pointing
// at the survivor. Nothing is deleted except rows that would be exact
// duplicates on the survivor.
//
// Usage:  node src/dedup-merge.js --dry-run   (print the plan, write nothing)
//         node src/dedup-merge.js             (execute)

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const need = (k) => {
  if (!process.env[k]) { console.error(`Missing env var ${k}`); process.exit(1); }
  return process.env[k];
};
const supabase = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'));

const DRY = process.argv.includes('--dry-run');

const fail = (context, error) => {
  const detail = [error?.code, error?.message, error?.details, error?.hint].filter(Boolean).join(' | ');
  throw new Error(`${context}: ${detail || JSON.stringify(error)}`);
};

async function all(table, select) {
  const out = []; const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + size - 1);
    if (error) fail(`Loading ${table}`, error);
    out.push(...data); if (data.length < size) break;
  }
  return out;
}

// ---------- normalizers ----------
export const normUrl = (u) => (u || '').toLowerCase().trim()
  .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');

export const normName = (s) => (s || '').toLowerCase()
  .replace(/\b(llc|inc|ltd|co|company|corp|dba|the)\b\.?/g, ' ')
  .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

export const normValue = (s) => (s || '').toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const facetKey = (f) => `${f.facet_type}|${f.label}`;

/** Same facet_type + label, and same number or same normalized text. */
function isDuplicateFacet(candidate, existingList) {
  for (const e of existingList) {
    if (candidate.value_numeric != null && e.value_numeric != null) {
      if (Number(candidate.value_numeric) === Number(e.value_numeric)) return true;
    }
    if (normValue(candidate.value) === normValue(e.value)) return true;
  }
  return false;
}

// ---------- preflight ----------
async function preflight() {
  const { error } = await supabase.from('providers').select('merged_into').limit(1);
  if (error) {
    console.error(
      '\nPreflight failed: providers.merged_into is missing.\n' +
      'Run sql/migrations/004-merged-status.sql in the Supabase SQL editor first.\n' +
      `(${error.code || ''} ${error.message})\n`
    );
    process.exit(1);
  }
}

// ---------- main ----------
if (!DRY) await preflight();

const providers = await all('providers', 'id, name, slug, website, status, categories, discovered_from, created_at');
const facets = await all('facets', 'id, provider_id, facet_type, label, value, value_numeric, source_id');
const services = await all('services', 'id, provider_id, name, source_id');
const sources = await all('sources', 'id, provider_id, url');

const byProv = (arr) => {
  const m = new Map();
  for (const x of arr) {
    if (!m.has(x.provider_id)) m.set(x.provider_id, []);
    m.get(x.provider_id).push(x);
  }
  return m;
};
const F = byProv(facets), S = byProv(services), U = byProv(sources);

// group live rows by confirmed name
const groups = new Map();
for (const p of providers) {
  if (p.status === 'merged') continue;
  const k = p.name.toLowerCase().trim();
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(p);
}

const totals = { groups: 0, skipped: 0, retired: 0, srcMoved: 0, srcDropped: 0, svcMoved: 0, svcDropped: 0, facMoved: 0, facDropped: 0 };

console.log(DRY ? '=== DRY RUN — no writes ===\n' : '=== LIVE MERGE ===\n');

for (const [, group] of groups) {
  if (group.length < 2) continue;

  const sites = [...new Set(group.map((p) => normUrl(p.website)).filter(Boolean))];
  if (sites.length > 1) {
    totals.skipped++;
    console.log(`SKIP "${group[0].name}" — ${sites.length} distinct websites, not a duplicate:`);
    for (const s of sites) console.log(`       ${s}`);
    console.log('');
    continue;
  }

  // survivor: most facets, tie-break earliest created
  const ranked = [...group].sort(
    (a, b) => (F.get(b.id)?.length || 0) - (F.get(a.id)?.length || 0) ||
              new Date(a.created_at) - new Date(b.created_at)
  );
  const survivor = ranked[0];
  const losers = ranked.slice(1);
  totals.groups++;

  console.log(`MERGE "${survivor.name}"`);
  console.log(`  survivor ${survivor.slug} (${F.get(survivor.id)?.length || 0} facets, via ${survivor.discovered_from})`);

  // survivor indexes for duplicate detection
  const survFacetIdx = new Map();
  for (const f of F.get(survivor.id) || []) {
    const k = facetKey(f);
    if (!survFacetIdx.has(k)) survFacetIdx.set(k, []);
    survFacetIdx.get(k).push(f);
  }
  const survSvcNames = new Set((S.get(survivor.id) || []).map((x) => normName(x.name)));
  const survSrcByUrl = new Map((U.get(survivor.id) || []).map((x) => [normUrl(x.url), x.id]));

  const categoryUnion = new Set(survivor.categories || []);

  for (const loser of losers) {
    const lSources = U.get(loser.id) || [];
    const lServices = S.get(loser.id) || [];
    const lFacets = F.get(loser.id) || [];
    for (const c of loser.categories || []) categoryUnion.add(c);

    // 1. sources first — build loser source id -> surviving source id
    const srcMap = new Map();
    const srcToDrop = [];
    let srcMoved = 0;
    for (const s of lSources) {
      const key = normUrl(s.url);
      if (survSrcByUrl.has(key)) {
        srcMap.set(s.id, survSrcByUrl.get(key));   // point at survivor's copy
        srcToDrop.push(s.id);
      } else {
        srcMap.set(s.id, s.id);                    // reassign this row as-is
        survSrcByUrl.set(key, s.id);
        srcMoved++;
        if (!DRY) {
          const { error } = await supabase.from('sources')
            .update({ provider_id: survivor.id }).eq('id', s.id);
          if (error) fail(`Reassigning source ${s.url}`, error);
        }
      }
    }

    // 2. services
    let svcMoved = 0, svcDropped = 0;
    for (const v of lServices) {
      if (survSvcNames.has(normName(v.name))) { svcDropped++; continue; }
      survSvcNames.add(normName(v.name));
      svcMoved++;
      if (!DRY) {
        const { error } = await supabase.from('services').update({
          provider_id: survivor.id,
          source_id: v.source_id ? (srcMap.get(v.source_id) ?? v.source_id) : null
        }).eq('id', v.id);
        if (error) fail(`Reassigning service ${v.name}`, error);
      }
    }

    // 3. facets
    let facMoved = 0, facDropped = 0;
    for (const f of lFacets) {
      const k = facetKey(f);
      const existing = survFacetIdx.get(k) || [];
      if (isDuplicateFacet(f, existing)) { facDropped++; continue; }
      if (!survFacetIdx.has(k)) survFacetIdx.set(k, []);
      survFacetIdx.get(k).push(f);
      facMoved++;
      if (!DRY) {
        // remap source BEFORE the duplicate source rows are deleted —
        // facets.source_id is NOT NULL ON DELETE CASCADE, so dropping a
        // still-referenced source would destroy the facet.
        const { error } = await supabase.from('facets').update({
          provider_id: survivor.id,
          source_id: srcMap.get(f.source_id) ?? f.source_id
        }).eq('id', f.id);
        if (error) fail(`Reassigning facet ${f.label}`, error);
      }
    }

    // 4. now nothing references the duplicate sources — safe to delete
    if (!DRY) {
      for (const id of srcToDrop) {
        const { error } = await supabase.from('sources').delete().eq('id', id);
        if (error) fail('Dropping duplicate source', error);
      }
      // remaining loser-owned rows are the skipped duplicates; clear them out
      const { error: sErr } = await supabase.from('services').delete().eq('provider_id', loser.id);
      if (sErr) fail('Clearing duplicate services', sErr);
      const { error: fErr } = await supabase.from('facets').delete().eq('provider_id', loser.id);
      if (fErr) fail('Clearing duplicate facets', fErr);

      const { error: pErr } = await supabase.from('providers').update({
        status: 'merged',
        merged_into: survivor.id,
        updated_at: new Date().toISOString()
      }).eq('id', loser.id);
      if (pErr) fail(`Tombstoning ${loser.slug}`, pErr);
    }

    totals.srcMoved += srcMoved; totals.srcDropped += srcToDrop.length;
    totals.svcMoved += svcMoved; totals.svcDropped += svcDropped;
    totals.facMoved += facMoved; totals.facDropped += facDropped;
    totals.retired++;

    console.log(
      `  retire  ${loser.slug} (via ${loser.discovered_from})\n` +
      `          facets  ${facMoved} moved / ${facDropped} dup dropped\n` +
      `          services ${svcMoved} moved / ${svcDropped} dup dropped\n` +
      `          sources ${srcMoved} moved / ${srcToDrop.length} dup dropped`
    );
  }

  if (!DRY) {
    const { error } = await supabase.from('providers').update({
      categories: [...categoryUnion],
      updated_at: new Date().toISOString()
    }).eq('id', survivor.id);
    if (error) fail(`Updating survivor ${survivor.slug}`, error);
  }
  console.log(`  categories -> [${[...categoryUnion].join(', ')}]\n`);
}

console.log('=== summary ===');
console.log(`groups merged      : ${totals.groups}`);
console.log(`groups skipped     : ${totals.skipped} (same name, different website)`);
console.log(`rows retired       : ${totals.retired}`);
console.log(`facets   moved/drop: ${totals.facMoved} / ${totals.facDropped}`);
console.log(`services moved/drop: ${totals.svcMoved} / ${totals.svcDropped}`);
console.log(`sources  moved/drop: ${totals.srcMoved} / ${totals.srcDropped}`);
console.log(`live businesses    : ${providers.filter((p) => p.status !== 'merged').length - totals.retired}`);
if (DRY) console.log('\nDry run — nothing was written. Re-run without --dry-run to execute.');
