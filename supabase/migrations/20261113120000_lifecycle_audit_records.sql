-- The agent's latest audit decision per lifecycle community (GoPlus + independent LP), kept so a restart does not
-- re-audit every open battle (provider calls plus one approval transaction per community) and delay a lock.
-- A row is written only after the arena accepted the matching `submit_lifecycle_audit`. It is a cache of the agent's
-- own decisions: the arena re-checks every approval at lock, and the agent re-validates a loaded row against the
-- current asset, policy hash and expiry, so a stale row can only cause a re-audit, never a lock.
-- Only the agent connects. Row-level security is on with NO policy and the public API roles have no grants.

create table public.lifecycle_audit_records (
  arena       text not null check (length(arena) between 1 and 256),
  battle_id   bigint not null check (battle_id >= 0),
  community   integer not null check (community >= 0),
  result      text not null,
  expires_at  timestamptz,
  decided_at  timestamptz not null,
  record      jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (arena, battle_id, community)
);
create index lifecycle_audit_records_expiry_idx on public.lifecycle_audit_records (arena, coalesce(expires_at, decided_at));

alter table public.lifecycle_audit_records enable row level security;
revoke all on table public.lifecycle_audit_records from anon, authenticated;
