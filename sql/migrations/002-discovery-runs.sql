-- ============================================================
-- 002-discovery-runs.sql
-- Checkpoint + cost ledger for the discovery seeder, mirroring research_runs.
--
-- One row per discovery query. The seeder skips any query that already has a
-- 'complete' row, so the pass is resumable: interrupt it and re-run.
--
-- Idempotent — safe to re-run.
-- ============================================================

create table if not exists discovery_runs (
  id uuid primary key default uuid_generate_v4(),
  query text not null,              -- the discovery query, verbatim; also written to providers.discovered_from
  category text,                    -- matrix axis: venue, entertainment, transportation, ...
  area text,                        -- matrix axis: French Quarter, Metairie, Northshore, ...
  model text not null,
  status text not null default 'started'
    check (status in ('started','complete','failed')),
  providers_found int default 0,    -- returned by the model
  inserted int default 0,           -- new rows written to providers
  skipped int default 0,            -- duplicates suppressed by dedup
  searches_used int default 0,
  input_tokens int default 0,
  output_tokens int default 0,
  cache_read_tokens int default 0,
  error text,
  started_at timestamptz default now(),
  finished_at timestamptz
);

create index if not exists idx_discovery_runs_status on discovery_runs(status);
create index if not exists idx_discovery_runs_query on discovery_runs(query);

-- match the rest of the archive: RLS on, service-role only
alter table discovery_runs enable row level security;

grant all privileges on table discovery_runs to service_role;
