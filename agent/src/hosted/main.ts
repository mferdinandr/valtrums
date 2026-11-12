import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKey, Near } from "near-kit";
import { NearActionReadSource } from "../mcp/actions/source.js";
import { playOnce, sweepOnce, type AutonomousAgentConfig, type FunctionCallRequest } from "../player/autonomous.js";
import { createModelProposer } from "../player/model.js";
import { Challenges, rpcKeyCheck } from "./auth.js";
import { parseKek } from "./crypto.js";
import { createPgDb } from "./db.js";
import { HostedAgents, ModelBudget, type Funds, type HostedLimits } from "./manager.js";
import { PgHostedRepository } from "./pg-store.js";
import { FileHostedRepository, type HostedRepository } from "./repository.js";
import { createHostedServer } from "./server.js";
import { DbSessions, HmacSessions, type SessionStore } from "./sessions.js";
import { AgentStates } from "./state-sync.js";
import { AgentStore } from "./store.js";

/**
 * `node dist/hosted/main.js`: the hosted-agent service (OpenSpec `hosted-player-agents`). TESTNET ONLY. The service holds
 * agent keys (encrypted) and the NEAR AI key, so it must never be pointed at a network with valuable funds.
 */
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const v = env[name]?.trim();
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
};
/** Limits have no defaults: the operator decides them. */
const limit = (env: NodeJS.ProcessEnv, name: string): number => {
  const n = Number(required(env, name));
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};

export async function runHostedService(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // The same guard as the agent CLI, but there is no default: hosting is a deliberate testnet choice.
  if (required(env, "NEAR_NETWORK") !== "testnet") throw new Error("hosted agents run on testnet only");
  const kek = parseKek(env.HOSTED_AGENT_KEK);
  const arena = required(env, "ARENA_CONTRACT_ID");
  const rpcUrl = env.NEAR_RPC_URL?.trim() || "https://rpc.testnet.near.org";
  const limits: HostedLimits = {
    maxAgentsPerOwner: limit(env, "HOSTED_AGENT_MAX_PER_OWNER"),
    maxModelCallsPerAgentHour: limit(env, "HOSTED_AGENT_MODEL_CALLS_PER_AGENT_HOUR"),
    maxModelCallsGlobalHour: limit(env, "HOSTED_AGENT_MODEL_CALLS_GLOBAL_HOUR"),
    maxTokenWholePerAgent: limit(env, "HOSTED_AGENT_MAX_TOKEN_WHOLE"),
  };
  const killPath = env.HOSTED_AGENT_KILL_SWITCH_PATH?.trim() || "./.agent-state/hosted/KILL";
  const dir = env.HOSTED_AGENT_STATE_DIR?.trim() || "./.agent-state/hosted";
  const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...event }));

  const reader = new Near({ network: "testnet", rpcUrl });
  const source = new NearActionReadSource(
    { network: "near-testnet", kind: "live", name: arena },
    (contractId, method, args) => reader.view(contractId, method, args),
    { arena, policy: null },
  );
  const joinable = async (): Promise<string[]> => {
    const page = await reader.view<Array<{ representation?: unknown }>>(arena, "get_lifecycle_joinable_assets", { from_index: "0", limit: "50" });
    return (Array.isArray(page) ? page : []).flatMap((a) => (typeof a.representation === "string" ? [a.representation] : []));
  };
  const battleCount = async (): Promise<number> => Number(await reader.view<string | number>(arena, "get_lifecycle_battle_count", {}));
  const nearBalance = async (account: string): Promise<bigint> => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "b", method: "query", params: { request_type: "view_account", finality: "final", account_id: account } }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { result?: { amount?: string } };
    return BigInt(body.result?.amount ?? "0"); // an account that does not exist yet has no balance
  };
  const funds = async (account: string): Promise<Funds> => ({
    nearYocto: await nearBalance(account),
    tokenBase: await Promise.all((await joinable()).map((t) => source.tokenBalance(t, account))),
  });

  // Postgres (Supabase) when HOSTED_AGENT_DATABASE_URL is set, else files under HOSTED_AGENT_STATE_DIR.
  const databaseUrl = env.HOSTED_AGENT_DATABASE_URL?.trim();
  let repo: HostedRepository;
  let sessions: SessionStore;
  let closeDb: () => Promise<void> = async () => {};
  if (databaseUrl) {
    const db = createPgDb(databaseUrl);
    await db.query("select 1"); // fail at startup, not on the first request, when the database cannot be reached
    repo = new PgHostedRepository(db);
    sessions = new DbSessions(db);
    closeDb = () => db.close();
  } else {
    repo = new FileHostedRepository(new AgentStore(`${dir}/agents.json`), dir);
    sessions = new HmacSessions(kek);
  }
  const states = new AgentStates(repo);
  const signers = new Map<string, Near>();
  let manager: HostedAgents;
  const budget = new ModelBudget(limits.maxModelCallsGlobalHour, Date.now, (account) => manager.recordModelCall(account));
  const model = budget.wrap(
    createModelProposer({
      apiKey: required(env, "NEAR_AI_API_KEY"),
      model: env.NEAR_AI_MODEL?.trim() || "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      ...(env.NEAR_AI_BASE_URL?.trim() ? { baseUrl: env.NEAR_AI_BASE_URL.trim() } : {}),
    }),
  );

  const runRound = async (agent: AutonomousAgentConfig, secretKey: string): Promise<void> => {
    let near = signers.get(agent.account);
    if (!near) {
      near = new Near({ network: "testnet", rpcUrl, privateKey: secretKey as `ed25519:${string}`, defaultSignerId: agent.account });
      signers.set(agent.account, near);
    }
    const signer = near;
    // Fail closed: state that could not be saved earlier, or that cannot be loaded, stops the agent from playing.
    const state = await states.state(agent.account);
    await states.flush(agent.account);
    const sign = async (a: AutonomousAgentConfig, call: FunctionCallRequest): Promise<string> => {
      const out = (await signer.call(call.receiverId, call.methodName, call.args, {
        gas: call.gas as never,
        attachedDeposit: BigInt(call.deposit) as never,
        signerId: a.account,
      })) as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } };
      const hash = out.transaction?.hash ?? out.transaction_outcome?.id;
      if (!hash) throw new Error("the transaction hash is missing");
      return hash;
    };
    try {
      await playOnce(agent, { arena, source, joinable, battleCount, sign, state, now: Date.now, log, live: true, model });
    } finally {
      // Persist what was done even when the round failed part way, so a deposit is never forgotten.
      await states.flush(agent.account);
    }
    await sweepOnce(agent, {
      joinable,
      balance: (token, account) => source.tokenBalance(token, account),
      registered: async (token, account) => (await reader.view(token, "storage_balance_of", { account_id: account })) !== null,
      sign,
      log,
      live: true,
    });
  };

  manager = new HostedAgents({
    repo,
    kek,
    limits,
    killSwitch: () => existsSync(killPath),
    now: Date.now,
    newKey: () => {
      const key = generateKey();
      return { account: hex(key.publicKey.data), publicKey: key.publicKey.toString(), secretKey: key.secretKey };
    },
    funds,
    runRound,
    log,
  });

  const server = createHostedServer({
    agents: manager,
    challenges: new Challenges(),
    sessions,
    keyBelongsTo: rpcKeyCheck(rpcUrl),
    allowedOrigin: required(env, "HOSTED_AGENT_ALLOWED_ORIGIN"),
    cookie: {
      ...(env.HOSTED_AGENT_COOKIE_SAMESITE ? { sameSite: parseSameSite(env.HOSTED_AGENT_COOKIE_SAMESITE) } : {}),
    },
  });
  const port = Number(env.PORT ?? 8792); // 8790 is the read API, 8791 the intents fixture
  server.listen(port, () => log({ event: "start", port, killSwitchPath: killPath, limits, store: databaseUrl ? "postgres" : "files" }));

  let running = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      running = false;
      server.close();
    });
  }
  while (running) {
    await manager.tick().catch((e) => log({ event: "tick_error", message: e instanceof Error ? e.message : String(e) }));
    await new Promise<void>((r) => setTimeout(r, 15_000));
  }
  await closeDb();
  log({ event: "stop" });
}

const parseSameSite = (v: string): "Lax" | "None" | "Strict" => {
  const s = v.trim().toLowerCase();
  if (s === "lax") return "Lax";
  if (s === "none") return "None";
  if (s === "strict") return "Strict";
  throw new Error("HOSTED_AGENT_COOKIE_SAMESITE must be Lax, None or Strict");
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runHostedService().catch((err) => {
    console.error(JSON.stringify({ event: "fatal", message: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
