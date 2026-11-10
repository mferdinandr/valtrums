export type NearNetwork = "testnet" | "mainnet";

const network: NearNetwork = process.env.NEXT_PUBLIC_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";

const DEFAULT_RPC: Record<NearNetwork, string> = {
  testnet: "https://rpc.testnet.near.org",
  mainnet: "https://rpc.mainnet.near.org",
};

/** Public, build-time configuration. Only NEXT_PUBLIC_* variables are read. */
export const config = {
  network,
  rpcUrl: process.env.NEXT_PUBLIC_NEAR_RPC_URL?.trim() || DEFAULT_RPC[network],
  arenaContractId: process.env.NEXT_PUBLIC_ARENA_CONTRACT_ID?.trim() ?? "",
  /** Id of the read deployment; it must match a deployment declared in the agent's manifest. */
  deployment: process.env.NEXT_PUBLIC_ARENA_READ_DEPLOYMENT?.trim() ?? "",
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
