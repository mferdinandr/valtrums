-- Hosted testnet agents (OpenSpec change `hosted-agents-database`).
-- Only the hosted-agent service connects to these tables. Row-level security is on with NO policy, and the default
-- grants are revoked from the public API roles, so `anon` and `authenticated` can neither read nor write anything.
-- The agent key is stored only as an encrypted blob (AES-256-GCM, key-encryption key kept outside the database).

create table public.hosted_agents (
  account       text primary key,
  owner         text not null,
  public_key    text not null,
  encrypted_key text not null,
  style         text not null check (style in ('crowd', 'underdog')),
  sweep         boolean not null default false,
  keep_whole    integer not null default 0 check (keep_whole >= 0),
  label         text,
  running       boolean not null default false,
  last_error    text,
  model_calls   bigint not null default 0 check (model_calls >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index hosted_agents_owner_idx on public.hosted_agents (owner);
create index hosted_agents_running_idx on public.hosted_agents (running) where running;

-- What the agent remembers between rounds (the record that stops it playing a battle twice).
create table public.hosted_agent_state (
  account    text primary key references public.hosted_agents (account) on delete cascade,
  state      jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.hosted_agent_events (
  id      bigint generated always as identity primary key,
  account text not null references public.hosted_agents (account) on delete cascade,
  kind    text not null check (kind in ('create', 'start', 'stop', 'error', 'export', 'kill_switch')),
  detail  jsonb not null default '{}'::jsonb,
  at      timestamptz not null default now()
);
create index hosted_agent_events_account_idx on public.hosted_agent_events (account, at desc);

-- Only a hash of the session token is stored, never the token.
create table public.hosted_sessions (
  token_hash text primary key,
  owner      text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index hosted_sessions_expires_idx on public.hosted_sessions (expires_at);

alter table public.hosted_agents       enable row level security;
alter table public.hosted_agent_state  enable row level security;
alter table public.hosted_agent_events enable row level security;
alter table public.hosted_sessions     enable row level security;

revoke all on table public.hosted_agents       from anon, authenticated;
revoke all on table public.hosted_agent_state  from anon, authenticated;
revoke all on table public.hosted_agent_events from anon, authenticated;
revoke all on table public.hosted_sessions     from anon, authenticated;
revoke all on sequence public.hosted_agent_events_id_seq from anon, authenticated;
