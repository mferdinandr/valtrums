-- Application state moved out of local files (OpenSpec change `app-state-database`).
-- Only the agent services (read API, workers, player programs) connect. Row-level security is on with NO policy and the
-- default grants are revoked from the public API roles, so `anon` and `authenticated` can neither read nor write.

-- Action identity and status (previews, authorization, broadcast). One row per action.
create table public.actions (
  action_id  text primary key,
  caller     text not null,
  status     text not null,
  record     jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index actions_caller_idx on public.actions (caller);

-- Audit report observations. Append-only: history is immutable in the database itself, not only in code.
create table public.audit_report_observations (
  seq                   bigint generated always as identity primary key,
  observation_id        text not null unique check (observation_id ~ '^[0-9a-f]{64}$'),
  arena                 text not null check (length(arena) between 1 and 256),
  battle_id             bigint not null check (battle_id >= 0),
  community             integer not null check (community >= 0),
  evidence_hash         text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  provenance            text not null check (provenance in ('fixture', 'recorded', 'live')),
  report_schema_version text not null,
  observation           jsonb not null,
  archived_at           timestamptz not null default now()
);
create index audit_report_observations_battle_idx on public.audit_report_observations (arena, battle_id, community, seq);

create function public.audit_report_observations_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit report observations are append-only';
end;
$$;
create trigger audit_report_observations_no_change
  before update or delete on public.audit_report_observations
  for each row execute function public.audit_report_observations_immutable();
create trigger audit_report_observations_no_truncate
  before truncate on public.audit_report_observations
  for each statement execute function public.audit_report_observations_immutable();

-- What a player agent program remembers between runs (the guard against playing a battle twice).
create table public.player_state (
  agent      text primary key,
  state      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Watchdog liquidity baselines recorded when a battle was approved (USD per token).
create table public.watchdog_baselines (
  battle_id   bigint primary key check (battle_id >= 0),
  baseline    jsonb not null,
  recorded_at timestamptz not null default now()
);

alter table public.actions                   enable row level security;
alter table public.audit_report_observations enable row level security;
alter table public.player_state              enable row level security;
alter table public.watchdog_baselines        enable row level security;

revoke all on table public.actions                   from anon, authenticated;
revoke all on table public.audit_report_observations from anon, authenticated;
revoke all on table public.player_state              from anon, authenticated;
revoke all on table public.watchdog_baselines        from anon, authenticated;
revoke all on sequence public.audit_report_observations_seq_seq from anon, authenticated;
revoke all on function public.audit_report_observations_immutable() from public, anon, authenticated;
