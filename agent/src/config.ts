import { readFileSync } from "node:fs";

export interface AgentConfig {
  network: "testnet" | "mainnet";
  rpcUrl: string;
  arenaContractId: string;
  agentAccountId: string;
  /** Secret. Never log or serialize this value. */
  agentPrivateKey: string;
  dexscreenerApiKey: string | undefined;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
}

/**
 * Resolve the private key from `AGENT_PRIVATE_KEY` or from the file named by
 * `AGENT_PRIVATE_KEY_FILE` (a mounted secret). Exactly one must be set. Error
 * messages name the variables only, never the value.
 */
export function resolveAgentKey(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string {
  const direct = env.AGENT_PRIVATE_KEY?.trim();
  const file = env.AGENT_PRIVATE_KEY_FILE?.trim();
  if (direct && file) {
    throw new Error("set only one of AGENT_PRIVATE_KEY and AGENT_PRIVATE_KEY_FILE, not both");
  }
  if (!direct && !file) {
    throw new Error("missing agent key: set AGENT_PRIVATE_KEY or AGENT_PRIVATE_KEY_FILE");
  }
  if (direct) return direct;
  let content: string;
  try {
    content = readFile(file as string);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(`cannot read AGENT_PRIVATE_KEY_FILE${code ? ` (${code})` : ""}`);
  }
  const key = content.trim();
  if (!key) throw new Error("AGENT_PRIVATE_KEY_FILE is empty");
  return key;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  readFile?: (path: string) => string,
): AgentConfig {
  const network = (env.NEAR_NETWORK?.trim() || "testnet") as string;
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error(`NEAR_NETWORK must be "testnet" or "mainnet"`);
  }
  const key = resolveAgentKey(env, readFile);
  if (!key.startsWith("ed25519:")) {
    // Do not echo the value: it is a secret.
    throw new Error("the agent private key must be an ed25519:... key");
  }
  return {
    network,
    rpcUrl: env.NEAR_RPC_URL?.trim() || "https://rpc.testnet.near.org",
    arenaContractId: required(env, "ARENA_CONTRACT_ID"),
    agentAccountId: required(env, "AGENT_ACCOUNT_ID"),
    agentPrivateKey: key,
    dexscreenerApiKey: env.DEXSCREENER_API_KEY?.trim() || undefined,
  };
}
