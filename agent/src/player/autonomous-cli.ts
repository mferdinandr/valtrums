import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Near } from "near-kit";
import { NearActionReadSource } from "../mcp/actions/source.js";
import { parseAutonomousAgents, playOnce, sweepOnce, type AutonomousAgentConfig, type FunctionCallRequest } from "./autonomous.js";
import { createModelProposer } from "./model.js";
import { PlayerState } from "./state.js";

/**
 * `node dist/player/autonomous-cli.js --config <agents.json> [--live] [--once]`
 *
 * Runs autonomous player agents: each has its own NEAR account and token balance and plays by itself. Dry run by
 * default (it chooses and plans, signs nothing). `--live` signs with the key named in each agent's `keyEnv`.
 * Testnet only. A key is read from its environment variable, is never logged and never appears in the config.
 */
const required = (env: NodeJS.ProcessEnv, name: string): string => {
  const v = env[name]?.trim();
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
};

export async function runAutonomousCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const live = argv.includes("--live");
  const once = argv.includes("--once");
  const at = argv.indexOf("--config");
  const configPath = (at >= 0 ? argv[at + 1] : undefined) ?? env.PLAYER_AUTONOMOUS_PATH?.trim();
  if (!configPath) throw new Error("pass --config <file> or set PLAYER_AUTONOMOUS_PATH");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw new Error("autonomous agent config is not readable JSON");
  }
  const agents = parseAutonomousAgents(parsed);

  const network = env.NEAR_NETWORK?.trim() || "testnet";
  if (network !== "testnet") throw new Error("autonomous agents run on testnet only");
  const arena = required(env, "ARENA_CONTRACT_ID");
  const rpcUrl = env.NEAR_RPC_URL?.trim() || `https://rpc.${network}.near.org`;
  const reader = new Near({ network: "testnet", rpcUrl });
  const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...event }));

  const source = new NearActionReadSource(
    { network: `near-${network}`, kind: "live", name: arena },
    (contractId, method, args) => reader.view(contractId, method, args),
    // No policy contract: autonomous agents use no grants.
    { arena, policy: null },
  );
  const joinable = async (): Promise<string[]> => {
    const page = await reader.view<Array<{ representation?: unknown }>>(arena, "get_lifecycle_joinable_assets", { from_index: "0", limit: "50" });
    return (Array.isArray(page) ? page : []).flatMap((a) => (typeof a.representation === "string" ? [a.representation] : []));
  };
  const battleCount = async (): Promise<number> => Number(await reader.view<string | number>(arena, "get_lifecycle_battle_count", {}));

  // NEAR AI Cloud (inference inside a TEE) decides every play, so its key is required. Fail early, before anything is sent.
  const model = createModelProposer({
    apiKey: required(env, "NEAR_AI_API_KEY"),
    // A private (TEE) model that is listed by GET /v1/models; DeepSeek-V3.1 is no longer served.
    model: env.NEAR_AI_MODEL?.trim() || "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    ...(env.NEAR_AI_BASE_URL?.trim() ? { baseUrl: env.NEAR_AI_BASE_URL.trim() } : {}),
  });

  const state = new PlayerState(env.PLAYER_AUTONOMOUS_STATE_PATH?.trim() || "./.agent-state/player-autonomous.json");
  const signers = new Map<string, Near>();
  if (live) {
    for (const a of agents) {
      const key = env[a.keyEnv]?.trim();
      if (!key) throw new Error(`missing key: set ${a.keyEnv}`);
      if (!key.startsWith("ed25519:")) throw new Error(`${a.keyEnv} must be an ed25519:... key`);
      signers.set(a.account, new Near({ network: "testnet", rpcUrl, privateKey: key as `ed25519:${string}`, defaultSignerId: a.account }));
    }
  }
  const sign = async (agent: AutonomousAgentConfig, call: FunctionCallRequest): Promise<string> => {
    const near = signers.get(agent.account);
    if (!near) throw new Error("nothing to sign");
    const out = (await near.call(call.receiverId, call.methodName, call.args, {
      gas: call.gas as never,
      attachedDeposit: BigInt(call.deposit) as never,
      signerId: agent.account,
    })) as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } };
    const hash = out.transaction?.hash ?? out.transaction_outcome?.id;
    if (!hash) throw new Error("the transaction hash is missing");
    return hash;
  };

  log({ event: "start", live, agents: agents.map((a) => ({ account: a.account, style: a.style, decidedBy: "near-ai" })) });
  let running = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (running = false));
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  while (running) {
    for (const agent of agents) {
      await playOnce(agent, { arena, source, joinable, battleCount, sign, state, now: Date.now, log, live, model }).catch((e) =>
        log({ event: "error", agent: agent.account, message: e instanceof Error ? e.message : String(e) }),
      );
      // Optional: send surplus tokens (above keepWhole) back to the owner. Off unless the agent has sweepTo.
      await sweepOnce(agent, {
        joinable,
        balance: (token, account) => source.tokenBalance(token, account),
        registered: async (token, account) => (await reader.view(token, "storage_balance_of", { account_id: account })) !== null,
        sign,
        log,
        live,
      }).catch((e) => log({ event: "sweep_error", agent: agent.account, message: e instanceof Error ? e.message : String(e) }));
    }
    if (once) break;
    await wait(Math.min(...agents.map((a) => a.intervalSecs)) * 1_000);
  }
  log({ event: "stop" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAutonomousCli(process.argv.slice(2)).catch((err) => {
    console.error(JSON.stringify({ event: "fatal", message: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
