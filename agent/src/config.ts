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

export function loadConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const network = (env.NEAR_NETWORK?.trim() || "testnet") as string;
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error(`NEAR_NETWORK must be "testnet" or "mainnet"`);
  }
  const key = required(env, "AGENT_PRIVATE_KEY");
  if (!key.startsWith("ed25519:")) {
    // Do not echo the value: it is a secret.
    throw new Error("AGENT_PRIVATE_KEY must be an ed25519:... key");
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
