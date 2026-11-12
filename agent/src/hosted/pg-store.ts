import { validatePlayerState, type PlayerStateData } from "../player/state.js";
import type { Db } from "./db.js";
import type { EventKind, HostedRepository } from "./repository.js";
import type { HostedAgent } from "./store.js";

interface AgentRow {
  account: string;
  owner: string;
  public_key: string;
  encrypted_key: string;
  style: "crowd" | "underdog";
  sweep: boolean;
  keep_whole: number;
  running: boolean;
  last_error: string | null;
  model_calls: string | number;
  created_at: Date | string;
}

const COLUMNS = "account, owner, public_key, encrypted_key, style, sweep, keep_whole, running, last_error, model_calls, created_at";

const toAgent = (r: AgentRow): HostedAgent => ({
  account: r.account,
  owner: r.owner,
  publicKey: r.public_key,
  encryptedKey: r.encrypted_key,
  style: r.style,
  sweep: r.sweep,
  keepWhole: r.keep_whole,
  running: r.running,
  createdAt: new Date(r.created_at).getTime(),
  lastError: r.last_error,
  modelCalls: Number(r.model_calls),
  // Exports live in the event log in the database; the record does not carry them.
  exports: [],
});

/** Postgres implementation of the hosted repository (schema: supabase/migrations/*_hosted_agents.sql). */
export class PgHostedRepository implements HostedRepository {
  constructor(private readonly db: Db) {}

  async get(account: string) {
    const { rows } = await this.db.query<AgentRow>(`select ${COLUMNS} from public.hosted_agents where account = $1`, [account]);
    return rows[0] ? toAgent(rows[0]) : undefined;
  }
  async byOwner(owner: string) {
    const { rows } = await this.db.query<AgentRow>(`select ${COLUMNS} from public.hosted_agents where owner = $1 order by created_at`, [owner]);
    return rows.map(toAgent);
  }
  async running() {
    const { rows } = await this.db.query<AgentRow>(`select ${COLUMNS} from public.hosted_agents where running order by created_at`);
    return rows.map(toAgent);
  }

  async create(agent: HostedAgent, maxPerOwner: number) {
    return this.db.transaction(async (tx) => {
      // One lock per owner for this transaction, so two creates at the limit cannot both pass the count.
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [agent.owner]);
      const { rows } = await tx.query<{ n: number }>("select count(*)::int as n from public.hosted_agents where owner = $1", [agent.owner]);
      if ((rows[0]?.n ?? 0) >= maxPerOwner) return false;
      await tx.query(
        `insert into public.hosted_agents (account, owner, public_key, encrypted_key, style, sweep, keep_whole, running, last_error, model_calls, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [agent.account, agent.owner, agent.publicKey, agent.encryptedKey, agent.style, agent.sweep, agent.keepWhole, agent.running, agent.lastError, agent.modelCalls, new Date(agent.createdAt)],
      );
      await tx.query("insert into public.hosted_agent_events (account, kind, detail) values ($1, 'create', $2)", [agent.account, JSON.stringify({ owner: agent.owner })]);
      return true;
    });
  }

  async setRunning(account: string, running: boolean, lastError: string | null) {
    await this.db.query("update public.hosted_agents set running = $2, last_error = $3, updated_at = now() where account = $1", [account, running, lastError]);
  }
  async incrementModelCalls(account: string) {
    await this.db.query("update public.hosted_agents set model_calls = model_calls + 1 where account = $1", [account]);
  }
  async recordEvent(account: string, kind: EventKind, detail: Record<string, unknown> = {}, at?: number) {
    await this.db.query("insert into public.hosted_agent_events (account, kind, detail, at) values ($1, $2, $3, coalesce($4, now()))", [account, kind, JSON.stringify(detail), at === undefined ? null : new Date(at)]);
  }

  async loadState(account: string): Promise<PlayerStateData | null> {
    const { rows } = await this.db.query<{ state: unknown }>("select state from public.hosted_agent_state where account = $1", [account]);
    return rows[0] ? validatePlayerState(rows[0].state as Partial<PlayerStateData>) : null;
  }
  async saveState(account: string, data: PlayerStateData) {
    await this.db.query(
      `insert into public.hosted_agent_state (account, state, updated_at) values ($1, $2, now())
       on conflict (account) do update set state = excluded.state, updated_at = now()`,
      [account, JSON.stringify(data)],
    );
  }

  /** Counts the exports of an agent (used by tests and operators; the record itself does not carry them). */
  async exportTimes(account: string): Promise<number[]> {
    const { rows } = await this.db.query<{ at: Date | string }>("select at from public.hosted_agent_events where account = $1 and kind = 'export' order by at", [account]);
    return rows.map((r) => new Date(r.at).getTime());
  }
}
