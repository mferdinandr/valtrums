export type NearNetwork = "testnet" | "mainnet";

const network: NearNetwork = process.env.NEXT_PUBLIC_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";

const DEFAULT_RPC: Record<NearNetwork, string> = {
  testnet: "https://rpc.testnet.near.org",
  mainnet: "https://rpc.mainnet.near.org",
};

const arenaContractId = process.env.NEXT_PUBLIC_ARENA_CONTRACT_ID?.trim() ?? "";

/** Public, build-time configuration. Only NEXT_PUBLIC_* variables are read. */
export const config = {
  network,
  rpcUrl: process.env.NEXT_PUBLIC_NEAR_RPC_URL?.trim() || DEFAULT_RPC[network],
  arenaContractId,
  /** Without a contract id the app runs entirely on the deterministic in-memory mock. */
  mock: arenaContractId === "",
  explorerUrl: network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io",
} as const;
