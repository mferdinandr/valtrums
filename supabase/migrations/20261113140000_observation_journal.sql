-- The observation journal and the lifecycle oracle status in the application database (OpenSpec change
-- `observation-journal-database`). Used only when a process runs with OBSERVATION_JOURNAL_STORE=database.
-- Only the agent services (collector, oracle, read API) connect. RLS is on with NO policy and the public API roles have
-- no grants, so `anon` and `authenticated` can neither read nor write.

-- One row per journal record, exactly the fields of a file journal line, one hash chain per namespace:
-- hash = sha256(prev_hash || canonicalJson({ seq, kind, body })), from a genesis of 64 zeros. Append-only in the
-- database itself; any edit, reorder or gap is detected by every reader as corruption.
create table public.observation_journal (
  namespace_key   text not null check (length(namespace_key) between 1 and 1024),
  seq             bigint not null check (seq >= 1),
  kind            text not null check (kind in ('observation', 'retraction')),
  body            jsonb not null,
  prev_hash       text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash            text not null check (hash ~ '^[0-9a-f]{64}$'),
  -- Set for observations: its id and source evidence slot. Set for retractions: the observation it retracts.
  observation_id  text check (observation_id ~ '^[0-9a-f]{64}$'),
  slot_key        text,
  retracts        text check (retracts ~ '^[0-9a-f]{64}$'),
  battle_id       bigint check (battle_id >= 0),
  round_id        bigint check (round_id >= 0),
  line_bytes      integer not null check (line_bytes > 0),
  recorded_at     timestamptz not null default now(),
  primary key (namespace_key, seq),
  check ((kind = 'observation') = (observation_id is not null and slot_key is not null and retracts is null)),
  check ((kind = 'retraction') = (retracts is not null and observation_id is null and slot_key is null))
);
create unique index observation_journal_observation_idx on public.observation_journal (namespace_key, observation_id) where observation_id is not null;
create unique index observation_journal_slot_idx on public.observation_journal (namespace_key, slot_key) where slot_key is not null;
create unique index observation_journal_retraction_idx on public.observation_journal (namespace_key, retracts) where retracts is not null;
create index observation_journal_round_idx on public.observation_journal (namespace_key, battle_id, round_id, seq);

create function public.observation_journal_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'observation journal records are append-only';
end;
$$;
create trigger observation_journal_no_change
  before update or delete on public.observation_journal
  for each row execute function public.observation_journal_immutable();
create trigger observation_journal_no_truncate
  before truncate on public.observation_journal
  for each statement execute function public.observation_journal_immutable();

-- The head of each namespace's chain, written in the same transaction as the record it points at (it replaces the
-- file journal's manifest, which could lag by one; here it never lags). Readers refuse a head that disagrees with the rows.
create table public.observation_journal_head (
  namespace_key text primary key check (length(namespace_key) between 1 and 1024),
  seq           bigint not null check (seq >= 0),
  head_hash     text not null check (head_hash ~ '^[0-9a-f]{64}$'),
  bytes         bigint not null check (bytes >= 0),
  updated_at    timestamptz not null default now()
);

-- Non-authoritative lifecycle oracle status, one row per namespace, replaced after every pass.
create table public.lifecycle_oracle_status (
  namespace_key text primary key check (length(namespace_key) between 1 and 1024),
  status        jsonb not null,
  updated_at    timestamptz not null default now()
);

alter table public.observation_journal      enable row level security;
alter table public.observation_journal_head enable row level security;
alter table public.lifecycle_oracle_status  enable row level security;

revoke all on table public.observation_journal      from anon, authenticated;
revoke all on table public.observation_journal_head from anon, authenticated;
revoke all on table public.lifecycle_oracle_status  from anon, authenticated;
revoke all on function public.observation_journal_immutable() from public, anon, authenticated;
