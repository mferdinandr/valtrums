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
  applicationDeployment: process.env.NEXT_PUBLIC_ARENA_READ_DEPLOYMENT?.trim() || null,
  /** Application read mode has no wallet unless this is "true"; the legacy ArenaApi is never provided there. */
  applicationWallet: process.env.NEXT_PUBLIC_APPLICATION_WALLET === "true",
  applicationProtocol: process.env.NEXT_PUBLIC_ARENA_READ_PROTOCOL?.trim() || "lifecycle-v2",
  /** Without a contract id the app runs entirely on the deterministic in-memory mock. */
  mock: arenaContractId === "",
  /** Cross-chain funding backend for the terminal: the deterministic mock, or NEAR Intents (1Click). */
  fundingRouter: process.env.NEXT_PUBLIC_FUNDING_ROUTER === "intents" ? ("intents" as const) : ("mock" as const),
  explorerUrl: network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io",
} as const;
