import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validatePlayerState, type PlayerStateData } from "../player/state.js";
import { createPgDb, type Db } from "./db.js";
import { AgentStore, type HostedAgent } from "./store.js";

/**
 * One-time import of the file store (`agents.json` and `state-<account>.json`) into the Postgres tables. It never
 * decrypts a key, never changes a value and is safe to run twice: rows that already exist are left as they are, and
 * the events of an agent are written only when the agent itself is new.
 */
export interface ImportResult {
  agents: number;
  skippedAgents: number;
  states: number;
}

export async function importHostedData(db: Db, agents: HostedAgent[], states: ReadonlyMap<string, PlayerStateData>): Promise<ImportResult> {
  const result: ImportResult = { agents: 0, skippedAgents: 0, states: 0 };
  for (const a of agents) {
    // A stored key must already be an encrypted blob; plain text is refused rather than copied.
    if (!/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/.test(a.encryptedKey)) throw new Error(`agent ${a.account} has a key that is not an encrypted blob`);
    await db.transaction(async (tx) => {
      const inserted = await tx.query(
        `insert into public.hosted_agents (account, owner, public_key, encrypted_key, style, sweep, keep_whole, running, last_error, model_calls, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10) on conflict (account) do nothing returning account`,
        [a.account, a.owner, a.publicKey, a.encryptedKey, a.style, a.sweep, a.keepWhole, a.lastError, a.modelCalls, new Date(a.createdAt)],
      );
      if (inserted.rows.length === 0) {
        result.skippedAgents += 1;
        return;
      }
      result.agents += 1;
      await tx.query("insert into public.hosted_agent_events (account, kind, detail, at) values ($1, 'create', $2, $3)", [a.account, JSON.stringify({ owner: a.owner, imported: true }), new Date(a.createdAt)]);
      for (const at of a.exports) await tx.query("insert into public.hosted_agent_events (account, kind, detail, at) values ($1, 'export', '{}'::jsonb, $2)", [a.account, new Date(at)]);
      const state = states.get(a.account);
      if (state) {
        await tx.query("insert into public.hosted_agent_state (account, state) values ($1, $2) on conflict (account) do nothing", [a.account, JSON.stringify(state)]);
        result.states += 1;
      }
    });
  }
  return result;
}

/** Reads `agents.json` and the state files from `dir`. A malformed file stops the import. */
export function readHostedFiles(dir: string): { agents: HostedAgent[]; states: Map<string, PlayerStateData> } {
  const agents = new AgentStore(`${dir}/agents.json`).all();
  const states = new Map<string, PlayerStateData>();
  for (const a of agents) {
    const path = `${dir}/state-${a.account}.json`;
    if (existsSync(path)) states.set(a.account, validatePlayerState(JSON.parse(readFileSync(path, "utf8"))));
  }
  return { agents, states };
}

/** `node dist/hosted/import.js`: HOSTED_AGENT_DATABASE_URL and HOSTED_AGENT_STATE_DIR (default ./.agent-state/hosted). */
async function main(): Promise<void> {
  const url = process.env.HOSTED_AGENT_DATABASE_URL?.trim();
  if (!url) throw new Error("set HOSTED_AGENT_DATABASE_URL");
  const dir = process.env.HOSTED_AGENT_STATE_DIR?.trim() || "./.agent-state/hosted";
  if (!existsSync(`${dir}/agents.json`)) throw new Error(`no agents.json in ${dir}`);
  const { agents, states } = readHostedFiles(dir);
  const db = createPgDb(url);
  try {
    console.log(JSON.stringify({ event: "import", ...(await importHostedData(db, agents, states)), read: agents.length }));
  } finally {
    await db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(JSON.stringify({ event: "fatal", message: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
