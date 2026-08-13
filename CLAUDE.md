# CLAUDE.md — NOLA Archive

## Working rules

This repo follows Rob's standard loop: chat writes briefs, Rob relays them here,
this agent implements end-to-end and commits.

- **Complete deployable output over instructions.** Ship working code, run it,
  verify it. Don't hand back a plan when the task was the thing itself.
- **Recon before build.** Read the existing files first — README, schema, seeds,
  all of `src/` — before changing anything.
- **Evidence before theory when debugging.** Read the real error and the
  `research_runs.error` column before touching `src/`. Do not guess, and do not
  weaken extraction rules to make a run pass.
- **Secrets live in `.env` / environment only.** Never print a secret value.
  Only secret *names* (`ANTHROPIC_API_KEY`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SHIELD_BLOCKLIST_PATH`) appear in conversation,
  commits, or logs.
- **Plain, brief communication.** Short summaries, real numbers, no padding.

## Repo specifics

### Purpose

A Trustlight-owned public-source archive of New Orleans experience providers,
built for corporate group programs. Every fact in it comes from a public source
the research agent actually retrieved.

**No client vendor data may ever enter this repo** — no vendor file, no contact
data, no client-confidential material. The archive is built from the public
provider universe only.

### Stack

- **Supabase Postgres** — the archive (`sql/schema.sql`). RLS enabled, no
  policies; service role only.
- **Claude API**, `claude-sonnet-4-6` with the web search server tool — the
  research agent.
- **Plain Node 20+, ESM, no framework.** Dependencies: `@anthropic-ai/sdk`,
  `@supabase/supabase-js`, `dotenv`.

### Key invariants

- **Every fact needs a `source_id`.** `facets.source_id` is `not null`. The
  agent drops any facet whose `source_ref` doesn't resolve to a row in
  `sources` — unsourced facts never reach the database.
- **No inference in extraction.** The system prompt in
  `src/extraction-prompt.js` forbids estimating, gap-filling, and reasoning from
  general knowledge. Do not soften those rules to raise coverage or make a
  failing run pass; if coverage is bad, that's a finding, not a bug to patch
  around.
- **Checkpointing lives in the `providers.status` column** — `pending` →
  `researching` → `complete` / `failed` / `not_found`. The loop is safe to
  interrupt and re-run; stuck `researching` rows are re-queued at startup. Retry
  a failure by flipping its status back to `pending`.
- **The shield-gate blocklist loads from `SHIELD_BLOCKLIST_PATH`, a local path
  outside the repo**, and blocklist/vendor filename patterns are gitignored. If
  a blocklist or vendor file ever appears in the tree, **stop and flag it** —
  do not commit, do not "fix" it by adding another ignore rule.

### Commands

```bash
npm run research       # process all pending providers
npm run research:one   # seed on first run, then research exactly one (smoke test)
npm run shield path/to/page.json   # Stage 4 publishing gate
```
