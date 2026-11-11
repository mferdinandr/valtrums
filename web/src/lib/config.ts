import { parseCreateModes } from "@/lib/arena-read/create-review";

export type NearNetwork = "testnet" | "mainnet";

const network: NearNetwork = process.env.NEXT_PUBLIC_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";

// The official public testnet RPC rate limits per IP and answers 429 without CORS headers, which a browser reports
// as "Failed to fetch". FastNEAR answers with CORS open. Set NEXT_PUBLIC_NEAR_RPC_URL to use another provider.
const DEFAULT_RPC: Record<NearNetwork, string> = {
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://rpc.mainnet.near.org",
};

/** Public, build-time configuration. Only NEXT_PUBLIC_* variables are read. */
export const config = {
  network,
  rpcUrl: process.env.NEXT_PUBLIC_NEAR_RPC_URL?.trim() || DEFAULT_RPC[network],
  arenaContractId: process.env.NEXT_PUBLIC_ARENA_CONTRACT_ID?.trim() ?? "",
  /** Id of the read deployment; it must match a deployment declared in the agent's manifest. */
  deployment: process.env.NEXT_PUBLIC_ARENA_READ_DEPLOYMENT?.trim() ?? "",
  /** The player-policy contract that holds agent grants. Optional: without it the Agents page explains what to set. */
  policyContract: process.env.NEXT_PUBLIC_PLAYER_POLICY_CONTRACT_ID?.trim() ?? "",
  /** The faucet contract that hands out test tokens. Optional: without it the faucet page explains what to set. */
  faucetContract: process.env.NEXT_PUBLIC_FAUCET_CONTRACT_ID?.trim() ?? "",
  /** Scoring modes a new battle may use (comma-separated; default PriceGain). Must match the arena's observation policy. */
  createModes: parseCreateModes(process.env.NEXT_PUBLIC_LIFECYCLE_CREATE_MODES),
  /** The only protocol this application speaks. */
  protocol: (process.env.NEXT_PUBLIC_ARENA_READ_PROTOCOL?.trim() || "lifecycle-v2") as string,
  explorerUrl: network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io",
} as const;

/**
 * Required variables that are missing or invalid. There is one application and no fallback app: when this
 * list is not empty the app shows these names instead of rendering anything that could mislead.
 */
export function configProblems(c: Pick<typeof config, "arenaContractId" | "deployment" | "protocol"> = config): string[] {
  const out: string[] = [];
  if (!c.deployment) out.push("NEXT_PUBLIC_ARENA_READ_DEPLOYMENT");
  if (!c.arenaContractId) out.push("NEXT_PUBLIC_ARENA_CONTRACT_ID");
  if (c.protocol !== "lifecycle-v2") out.push("NEXT_PUBLIC_ARENA_READ_PROTOCOL (must be lifecycle-v2)");
  return out;
}
