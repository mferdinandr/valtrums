import { fileURLToPath } from "node:url";
import { Near } from "near-kit";
import { NearRpcReceiptVerifier } from "../mcp/actions/receipt.js";
import { ActionService } from "../mcp/actions/service.js";
import { NearActionReadSource } from "../mcp/actions/source.js";
import { appDb, closeAppDb } from "../app-state/app-db.js";
import { PgActionStore, loadPgPlayerState } from "../app-state/pg-stores.js";
import { ActionStore } from "../mcp/actions/store.js";
import { delegateGrantsOf, keyFor, loadPlayerAgents, type PlayerAgentConfig } from "./config.js";
import { createModelProposer } from "./model.js";
import { tick } from "./runner.js";
import { PlayerState } from "./state.js";

/**
 * `node dist/player/cli.js --config <agents.json> [--live] [--once]`
 *
 * Runs the player agents described in the config file. By default it is a dry run: it chooses, previews and prepares
 * the `reserve` transaction and stops, signing nothing. `--live` lets each agent sign its own `reserve` with the key
 * named in its config. The program never moves tokens and never holds a key of the user.
 */
const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const v = env[name]?.trim();
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
};

export async function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const live = argv.includes("--live");
  const once = argv.includes("--once");
  const at = argv.indexOf("--config");
  const configPath = (at >= 0 ? argv[at + 1] : undefined) ?? env.PLAYER_AGENTS_PATH?.trim();
  if (!configPath) throw new Error("pass --config <file> or set PLAYER_AGENTS_PATH");
  const agents = loadPlayerAgents(configPath);

  const network = env.NEAR_NETWORK?.trim() || "testnet";
  if (network !== "testnet") throw new Error("player agents run on testnet only");
  const arena = required(env, "ARENA_CONTRACT_ID");
  const policy = required(env, "PLAYER_POLICY_CONTRACT_ID");
  const rpcUrl = env.NEAR_RPC_URL?.trim() || `https://rpc.${network}.near.org`;
  const reader = new Near({ network: "testnet", rpcUrl });
  const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...event }));

  const source = new NearActionReadSource(
    { network: `near-${network}`, kind: "live", name: arena },
    (contractId, method, args) => reader.view(contractId, method, args),
    { arena, policy },
  );
  // With APP_DATABASE_URL the action store and the player state live in Postgres instead of local files.
  const db = appDb(env);
  const actions = new ActionService({
    source,
    ctx: { network: `near-${network}`, arena, payout: env.PAYOUT_CONTRACT_ID?.trim() || null, policy },
    store: db ? new PgActionStore(db) : new ActionStore(env.PLAYER_ACTION_STORE_PATH?.trim() || "./.data/player-actions.json"),
    // Player agents authorize with their grant, never with a user signature, so no signature is ever accepted here.
    verify: async () => false,
    recipient: env.ACTION_RECIPIENT?.trim() || "valtrum-player",
    receipts: new NearRpcReceiptVerifier(rpcUrl),
    delegateGrants: delegateGrantsOf(agents),
  });
  const pgState = db ? await loadPgPlayerState(db, "player:grants") : null;
  const state = pgState?.state ?? new PlayerState(env.PLAYER_STATE_PATH?.trim() || "./.data/player-state.json");
  const apiKey = env.NEAR_AI_API_KEY?.trim();
  const model = apiKey
    ? createModelProposer({ apiKey, model: env.NEAR_AI_MODEL?.trim() || "deepseek-ai/DeepSeek-V4.1-Flash-1017", ...(env.NEAR_AI_BASE_URL?.trim() ? { baseUrl: env.NEAR_AI_BASE_URL.trim() } : {}) })
    : undefined;

  // Each agent signs with its own key only; keys are read here and never logged.
  const signers = new Map<string, Near>();
  if (live) {
    for (const a of agents) {
      signers.set(a.delegate, new Near({ network: "testnet", rpcUrl, privateKey: keyFor(a, env) as `ed25519:${string}`, defaultSignerId: a.delegate }));
    }
  }
  const sign = async (agent: PlayerAgentConfig, tx: { receiverId: string; actions: Array<{ methodName: string; args: Record<string, unknown>; gas: string; deposit: string }> }): Promise<string> => {
    const near = signers.get(agent.delegate);
    const call = tx.actions[0];
    if (!near || !call || tx.actions.length !== 1) throw new Error("nothing to sign");
    const out = (await near.call(tx.receiverId, call.methodName, call.args, { gas: call.gas as never, attachedDeposit: BigInt(call.deposit) as never, signerId: agent.delegate })) as {
      transaction?: { hash?: string };
      transaction_outcome?: { id?: string };
    };
    const hash = out.transaction?.hash ?? out.transaction_outcome?.id;
    if (!hash) throw new Error("the transaction hash is missing");
    return hash;
  };
  const battleCount = async (): Promise<number> => Number(await reader.view<string | number>(arena, "get_lifecycle_battle_count", {}));

  log({ event: "start", live, agents: agents.map((a) => ({ delegate: a.delegate, strategy: a.strategy, mode: a.mode })) });
  let running = true;
  process.once("SIGINT", () => {
    running = false;
  });
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  while (running) {
    for (const agent of agents) {
      await tick(agent, { actions, source, battleCount, sign, state, ...(model ? { model } : {}), now: Date.now, log, live }).catch((e) =>
        log({ event: "error", agent: agent.delegate, message: e instanceof Error ? e.message : String(e) }),
      );
      // Persist what the round did even when it failed part way, so an action is never forgotten.
      await pgState?.flush();
    }
    if (once) break;
    await wait(Math.min(...agents.map((a) => a.intervalSecs)) * 1_000);
  }
  await closeAppDb();
  log({ event: "stop" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((err) => {
    console.error(JSON.stringify({ event: "fatal", message: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
