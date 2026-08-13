-- ============================================================
-- NOLA Archive — Supabase schema (pilot)
-- Run in Supabase SQL Editor. Service-role key bypasses RLS;
-- RLS is enabled with NO public policies, so the anon key can
-- read nothing until you deliberately add policies for the
-- future xai.fyi UI (Google-authenticated read access).
-- ============================================================

create extension if not exists "uuid-ossp";

-- ---------- providers: the public vendor universe ----------
create table if not exists providers (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  slug text not null unique,
  website text,
  city text default 'New Orleans',
  region text default 'Greater New Orleans',
  categories text[] default '{}',
  status text not null default 'pending'
    check (status in ('pending','researching','complete','failed','not_found')),
  discovered_from text,           -- how this provider entered the universe (seed, directory name, etc.)
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---------- sources: every fact traces to one of these ----------
create table if not exists sources (
  id uuid primary key default uuid_generate_v4(),
  provider_id uuid not null references providers(id) on delete cascade,
  url text not null,
  title text,
  publisher text,
  fetched_at timestamptz default now()
);

-- ---------- services: named offerings ----------
create table if not exists services (
  id uuid primary key default uuid_generate_v4(),
  provider_id uuid not null references providers(id) on delete cascade,
  name text not null,
  description text,
  confidence text not null default 'medium' check (confidence in ('high','medium','low')),
  source_id uuid references sources(id) on delete set null,
  created_at timestamptz default now()
);

-- ---------- facets: atomic capability facts ----------
create table if not exists facets (
  id uuid primary key default uuid_generate_v4(),
  provider_id uuid not null references providers(id) on delete cascade,
  service_id uuid references services(id) on delete set null,
  facet_type text not null check (facet_type in (
    'service','capacity','group_size','venue_format','neighborhood',
    'seasonal','pricing_signal','unique_attribute','booking_constraint',
    'amenity','accessibility','duration','other'
  )),
  label text not null,            -- short machine-friendly label, e.g. 'max_seated_capacity'
  value text not null,            -- human-readable fact, e.g. 'Seats up to 250 for private dinners'
  value_numeric numeric,          -- optional normalized number (250)
  unit text,                      -- optional unit ('guests','hours','USD')
  confidence text not null check (confidence in ('high','medium','low')),
  source_id uuid not null references sources(id) on delete cascade,
  created_at timestamptz default now()
);

-- ---------- experiences: Stage 3 cross-provider clusters ----------
create table if not exists experiences (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  slug text not null unique,
  description text,
  cluster_notes text,
  created_at timestamptz default now()
);

create table if not exists experience_facets (
  experience_id uuid references experiences(id) on delete cascade,
  facet_id uuid references facets(id) on delete cascade,
  primary key (experience_id, facet_id)
);

-- ---------- research_runs: checkpointing + cost ledger ----------
create table if not exists research_runs (
  id uuid primary key default uuid_generate_v4(),
  provider_id uuid not null references providers(id) on delete cascade,
  model text not null,
  status text not null default 'started'
    check (status in ('started','complete','failed')),
  searches_used int default 0,
  input_tokens int default 0,
  output_tokens int default 0,
  cache_read_tokens int default 0,
  error text,
  started_at timestamptz default now(),
  finished_at timestamptz
);

-- ---------- indexes ----------
create index if not exists idx_providers_status on providers(status);
create index if not exists idx_facets_provider on facets(provider_id);
create index if not exists idx_facets_type on facets(facet_type);
create index if not exists idx_sources_provider on sources(provider_id);
create index if not exists idx_services_provider on services(provider_id);

-- ---------- RLS: locked down by default ----------
alter table providers enable row level security;
alter table sources enable row level security;
alter table services enable row level security;
alter table facets enable row level security;
alter table experiences enable row level security;
alter table experience_facets enable row level security;
alter table research_runs enable row level security;

-- No policies created: anon/authenticated read NOTHING yet.
-- When the xai.fyi browser UI ships, add e.g.:
--   create policy "authenticated read" on providers
--     for select to authenticated using (true);
-- (repeat per table; keep writes service-role only)

-- ---------- grants: service_role needs table privileges ----------
-- RLS is only the second gate. Table GRANTs are the first, and they are NOT
-- automatic on every Supabase project — without these the service-role key gets
-- 403 / SQLSTATE 42501 "permission denied for table ..." on every request,
-- before RLS is ever consulted. Safe to re-run.
grant usage on schema public to service_role;

grant all privileges on table
  providers, sources, services, facets,
  experiences, experience_facets, research_runs
to service_role;

-- keep future tables in this schema working the same way
alter default privileges in schema public
  grant all on tables to service_role;
