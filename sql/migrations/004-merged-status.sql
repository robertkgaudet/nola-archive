-- ============================================================
-- 004-merged-status.sql
-- Tombstone support for post-research dedup.
--
-- Discovery deduped on the SEEDED name, but the research agent overwrites
-- `name` with `confirmed_name`. Two differently-seeded rows can therefore
-- converge on the same real business AFTER dedup has already run — 8 groups
-- (17 rows, 9 real businesses) did exactly that.
--
-- Losers are retired rather than deleted: status 'merged' + merged_into
-- pointing at the survivor.
--
-- The status check constraint is unnamed in schema.sql, so its real name is
-- whatever Postgres auto-generated. We look it up rather than assume, because
-- a `drop constraint if exists <wrong name>` silently no-ops and the
-- subsequent `add constraint` then fights the still-live original.
--
-- NOTE: numbering jumps 002 -> 004 to match the filename in the brief; there
-- is no 003.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- 1. drop every check constraint on providers that mentions `status`
do $$
declare c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.providers'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.providers drop constraint %I', c.conname);
  end loop;
end $$;

-- 2. re-add it, now including 'merged'
alter table public.providers add constraint providers_status_check check (status in (
  'pending','researching','complete','failed','not_found','merged'
));

-- 3. provenance column
alter table public.providers
  add column if not exists merged_into uuid references public.providers(id) on delete set null;

create index if not exists idx_providers_merged_into on public.providers(merged_into);

comment on column public.providers.merged_into is
  'When status = ''merged'', the surviving provider this row was folded into.';

-- ---------- verification (run this after; both rows should return) ----------
-- select column_name from information_schema.columns
--  where table_schema='public' and table_name='providers' and column_name='merged_into';
--
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--  where conrelid='public.providers'::regclass and contype='c';
