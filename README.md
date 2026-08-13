# NOLA Archive — Stage 1 Pilot

Trustlight-owned New Orleans experience knowledge base, built exclusively from the
public provider universe. This repo is the Stage 1 pilot: a checkpointed research
agent that profiles 10 seed providers into a Supabase archive where **every fact
carries a source URL and a confidence score**. No inference — unsourced facts are
dropped before they ever reach the database.

**Ownership note:** built from public sources on Trustlight infrastructure. No
client vendor file, contact data, or client-confidential material may enter this
repository. The Stage 4 shield-gate blocklist loads from a local path outside
the repo and is gitignored by pattern.

## Stack

- Supabase (Postgres) — the archive
- Claude API, `claude-sonnet-4-6` with web search — the research agent
- Node 20+ — plain JS, no framework
- Later: Cloudflare Pages UI on xai.fyi with Supabase Google sign-in (read-only
  policies to be added then; RLS ships locked)

## Setup (10 minutes)

1. **Supabase**: create a project (or pick an existing one). SQL Editor → paste
   and run `sql/schema.sql`. RLS is enabled with no policies — only the service
   role can touch the tables, which is correct for the pilot.
2. **Keys**: `cp .env.example .env` and fill in `ANTHROPIC_API_KEY`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API).
3. **Install**: `npm install`

## Run the pilot

```bash
npm run research:one    # smoke test — researches 1 provider
npm run research        # process all pending (≈10–15 min for the 10 seeds)
```

The loop is checkpointed in the database itself: interrupt any time, re-run, and
it resumes from `pending`. Failed providers are marked `failed` — flip their
status back to `pending` in the table editor to retry.

Expected cost for the full 10-provider pilot: roughly **$1–2** (search fees
dominate; the extraction prompt is cached across calls).

## What to inspect afterward (the point of the pilot)

Run these in the Supabase SQL editor and judge quality before scaling:

```sql
-- coverage: how many sourced facts per provider?
select p.name, p.status, count(f.id) facets, count(distinct s.id) sources
from providers p
left join facets f on f.provider_id = p.id
left join sources s on s.provider_id = p.id
group by p.id order by facets desc;

-- confidence mix — too much 'low' means the prompt needs tightening
select confidence, count(*) from facets group by confidence;

-- spot-check: click through source URLs and verify claims
select p.name, f.facet_type, f.value, f.confidence, s.url
from facets f join providers p on p.id = f.provider_id
join sources s on s.id = f.source_id
order by p.name limit 50;

-- cost ledger
select model, count(*) runs, sum(searches_used) searches,
       sum(input_tokens) tok_in, sum(output_tokens) tok_out,
       sum(cache_read_tokens) tok_cached
from research_runs group by model;
```

Decision gate: if facet coverage, confidence mix, and spot-checked accuracy look
right, tune the extraction prompt as needed and proceed to the discovery seeder
(full public provider universe). If not, iterate the prompt here — 10 providers
is the cheap place to learn.

## Repo map

```
sql/schema.sql            archive DDL (providers → services → facets → sources → experiences)
seeds/pilot-providers.json  10 seed providers, chosen from public prominence
src/extraction-prompt.js  schema-locked system prompt (cached)
src/research-agent.js     checkpointed Stage 1 loop
src/shield-gate.js        Stage 4 publishing gate (blocklist stays local, never committed)
```

## Working in Claude Code

Open this folder in VS Code and drive it with Claude Code. Useful first asks:

- "Run the smoke test and show me what landed in Supabase for that provider."
- "Tighten the extraction prompt — we're getting too many low-confidence facets."
- "Build the discovery seeder: enumerate New Orleans event providers from public
  directories into the providers table with discovered_from set."

## Roadmap (next stages)

1. **Discovery seeder** — expand from 10 seeds to the full public universe
2. **Stage 3a** — taxonomy clustering over facets (`claude-opus-4-8`, one-time)
3. **Stage 3b** — grounded page generation (`claude-sonnet-4-6`, Batch API)
4. **Stage 4** — shield gate + confidence-routed review + WordPress REST push
   with future-dated scheduling
5. **xai.fyi UI** — Cloudflare Pages + Supabase Google auth, read-only archive
   browser (add RLS read policies for `authenticated` at that point)
