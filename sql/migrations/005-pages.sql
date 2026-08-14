-- ============================================================
-- 005-pages.sql
-- Stage 3b: generated answer pages.
--
-- One row per page. Pages are written ONLY from archive facts; claim_map ties
-- every substantive claim back to the facet short-ids that evidence it, so a
-- page can always be audited against the archive that produced it.
--
-- Gate results live on the row (shield_*, claim_audit_*) rather than in a
-- separate log: a page and its verdict should never drift apart, and a page
-- that failed a gate must stay visibly failed rather than quietly draft.
--
-- Idempotent — safe to re-run.
-- ============================================================

create table if not exists pages (
  id uuid primary key default uuid_generate_v4(),
  experience_id uuid references experiences(id) on delete set null,

  slug text not null unique,
  title text not null,              -- the planner question this page answers
  direct_answer text,               -- 60-80 words, answers outright
  body_md text,                     -- markdown, operational depth
  faq jsonb,                        -- [{q, a}]
  related_slugs text[],
  meta_description text,
  claim_map jsonb,                  -- [{claim, facet_ids[]}]

  status text not null default 'draft'
    check (status in ('draft','review','approved','published','failed')),

  -- gate results
  shield_status text default 'not_run'
    check (shield_status in ('clean','flagged','not_run')),
  shield_hits jsonb,
  claim_audit_status text default 'not_run'
    check (claim_audit_status in ('pass','fail','not_run')),
  claim_audit_issues jsonb,

  -- cost ledger, same shape as research_runs
  model text,
  input_tokens int default 0,
  output_tokens int default 0,
  cache_read_tokens int default 0,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_pages_status on pages(status);
create index if not exists idx_pages_experience on pages(experience_id);

alter table pages enable row level security;

grant all privileges on table pages to service_role;

-- ---------- verification ----------
-- select count(*) from pages;
