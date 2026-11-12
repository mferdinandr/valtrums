import type { Db } from "../hosted/db.js";
import type { Baseline, BaselineStore } from "../baseline.js";
import { ActionStoreError, MAX_ACTIONS, type ActionRecord, type ActionStorePort } from "../mcp/actions/store.js";
import { PlayerState, validatePlayerState, type PlayerStateData } from "../player/state.js";

/**
 * Postgres implementations of the application stores (OpenSpec `app-state-database`). Each keeps the guarantees of its
 * file store: atomic updates, no silent reset, and an error (never an empty result) for a malformed stored record.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Action records, one row each. An update locks the action id for its transaction, so concurrent updates both apply. */
export class PgActionStore implements ActionStorePort {
  constructor(private readonly db: Db) {}

  async get(actionId: string): Promise<ActionRecord | null> {
    const { rows } = await this.db.query<{ record: unknown }>("select record from public.actions where action_id = $1", [actionId]);
    return rows[0] ? asRecord(rows[0].record, actionId) : null;
  }

  async update(actionId: string, update: (current: ActionRecord | null) => ActionRecord): Promise<ActionRecord> {
    return this.db.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`action:${actionId}`]);
      const { rows } = await tx.query<{ record: unknown }>("select record from public.actions where action_id = $1 for update", [actionId]);
      const current = rows[0] ? asRecord(rows[0].record, actionId) : null;
      const next = update(current ? structuredClone(current) : null); // may throw: the transaction rolls back
      if (!current) {
        // One lock for creations so the capacity check and the insert cannot interleave.
        await tx.query("select pg_advisory_xact_lock(hashtext('actions:create'))");
        const count = await tx.query<{ n: number }>("select count(*)::int as n from public.actions");
        if ((count.rows[0]?.n ?? 0) >= MAX_ACTIONS) throw new ActionStoreError("action store is full");
      }
      await tx.query(
        `insert into public.actions (action_id, caller, status, record) values ($1, $2, $3, $4)
         on conflict (action_id) do update set caller = excluded.caller, status = excluded.status, record = excluded.record, updated_at = now()`,
        [actionId, next.caller, next.status, JSON.stringify(next)],
      );
      return structuredClone(next);
    });
  }
}

function asRecord(value: unknown, actionId: string): ActionRecord {
  if (!isRecord(value) || value.actionId !== actionId || typeof value.caller !== "string" || typeof value.status !== "string" || !Array.isArray(value.history)) {
    throw new ActionStoreError(`stored action ${actionId} is malformed; it is kept unchanged for inspection`);
  }
  return value as unknown as ActionRecord;
}

/** Watchdog baselines per battle. A malformed row is an error, not lost state. */
export class PgBaselineStore implements BaselineStore {
  constructor(private readonly db: Db) {}

  async get(battleId: number): Promise<Baseline | undefined> {
    const { rows } = await this.db.query<{ baseline: unknown }>("select baseline from public.watchdog_baselines where battle_id = $1", [battleId]);
    if (!rows[0]) return undefined;
    const b = rows[0].baseline;
    if (!isRecord(b) || !Object.values(b).every((v) => typeof v === "number" && Number.isFinite(v))) {
      throw new Error(`stored baseline for battle ${battleId} is malformed`);
    }
    return b as Baseline;
  }

  async set(battleId: number, baseline: Baseline): Promise<void> {
    await this.db.query(
      `insert into public.watchdog_baselines (battle_id, baseline) values ($1, $2)
       on conflict (battle_id) do update set baseline = excluded.baseline, recorded_at = now()`,
      [battleId, JSON.stringify(baseline)],
    );
  }
}

/**
 * Player-agent state kept in the `player_state` table under `agent`. The agent loop stays synchronous: `PlayerState`
 * hands each change to `flush`, which writes the latest copy. A malformed row stops the program instead of being reset.
 */
export async function loadPgPlayerState(db: Db, agent: string): Promise<{ state: PlayerState; flush: () => Promise<void> }> {
  const { rows } = await db.query<{ state: unknown }>("select state from public.player_state where agent = $1", [agent]);
  const data = rows[0] ? validatePlayerState(rows[0].state as Partial<PlayerStateData>) : undefined;
  let pending: PlayerStateData | null = null;
  const state = new PlayerState(null, { ...(data ? { data } : {}), onSave: (d) => void (pending = d) });
  return {
    state,
    async flush() {
      const latest = pending;
      if (!latest) return;
      await db.query(
        `insert into public.player_state (agent, state) values ($1, $2)
         on conflict (agent) do update set state = excluded.state, updated_at = now()`,
        [agent, JSON.stringify(latest)],
      );
      if (pending === latest) pending = null;
    },
  };
}
