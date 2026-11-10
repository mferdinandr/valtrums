/**
 * Display labels for tokens. A label is only a name to show next to an address: the identity of a token is always
 * its chain id plus its address, and a label never makes a token eligible, audited or approved. Entries are
 * curated from two reviewed sources: the testnet mock deployment (`docs/evidence/2026-11-09-evm-testnet-deploy.json`,
 * name and symbol read back from the contracts) and the mainnet reference listing the mascots are matched to
 * (`web/src/components/colosseum/characters.json`). `token-labels.test.ts` fails when either source drifts.
 */
export type TokenLabelKind = "testnet-mock" | "mainnet-reference";

export interface TokenLabel {
  symbol: string;
  name: string;
  kind: TokenLabelKind;
}

/** Keyed by `${chainId}:${lowercase 0x address}`. */
const LABELS: ReadonlyMap<string, TokenLabel> = new Map<string, TokenLabel>([
  ["46630:0x5b2ba17e5be1b611c1299809db89c5fe21d9d0a6", { symbol: "mCASHCAT", name: "Mock CASHCAT", kind: "testnet-mock" }],
  ["46630:0x78e7621559bc0e3cc10f8bb61dc2a371afe66e27", { symbol: "mWALLET", name: "Mock WALLET", kind: "testnet-mock" }],
  ["46630:0xaed11a367b102f2da3ac2dfcf1de9cc97a47a850", { symbol: "mGOOD", name: "Mock GOOD", kind: "testnet-mock" }],
  ["46630:0x973c4e0601c03a4899b8c9643b299aaaece4ba0a", { symbol: "mAI", name: "Mock AI", kind: "testnet-mock" }],
  ["46630:0xd879e8483d63265abe2549a347017e59a04a15bc", { symbol: "mVLAD", name: "Mock VLAD", kind: "testnet-mock" }],
  ["46630:0x209aa417c2aa45a13304acc51c4c393d0ac5ba84", { symbol: "mDEGEN", name: "Mock DEGEN", kind: "testnet-mock" }],
  ["4663:0x020bfc650a365f8bb26819deaabf3e21291018b4", { symbol: "CASHCAT", name: "CASHCAT", kind: "mainnet-reference" }],
  ["4663:0xae2df3c1749daee721c1bfcbbfdde5d61ae7cb99", { symbol: "BTCETHUSDT", name: "BTCETHUSDT", kind: "mainnet-reference" }],
  ["4663:0x6511c233790ec10f7d673c64dc82c3f941d57828", { symbol: "OAK", name: "OAK", kind: "mainnet-reference" }],
  ["4663:0xb7ff57631b97000d950236ef63bd463da5beba7e", { symbol: "REBATE", name: "REBATE", kind: "mainnet-reference" }],
  ["4663:0x96c5d997a462bce2577bee9527a1a08101927519", { symbol: "WIF", name: "WIF", kind: "mainnet-reference" }],
  ["4663:0x0339f5459fc690ac85f1782e15782a151b4a9e1b", { symbol: "WALLET", name: "WALLET", kind: "mainnet-reference" }],
  ["4663:0x5f62c57e5c537887117eef828b7e3ad41c009feb", { symbol: "GOOD", name: "GOOD", kind: "mainnet-reference" }],
  ["4663:0x0d4a117dccce7ba3d0a475ec9068c20c35310fd8", { symbol: "AI", name: "AI", kind: "mainnet-reference" }],
  ["4663:0xfdbb27e971e72e38c41b1c772fb409c94dd92789", { symbol: "VLAD", name: "VLAD", kind: "mainnet-reference" }],
  ["4663:0x0830a9dd26a04e959657ab6788d45f5725590c32", { symbol: "DEGEN", name: "DEGEN", kind: "mainnet-reference" }],
]);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CHAIN = /^(0|[1-9][0-9]{0,19})$/;

/** The label for a token, or null when none is curated. Malformed input yields null, never a throw. */
export function labelFor(chainId: string | number, address: string): TokenLabel | null {
  const chain = String(chainId);
  if (!CHAIN.test(chain) || !ADDRESS.test(address)) return null;
  return LABELS.get(`${chain}:${address.toLowerCase()}`) ?? null;
}

/** True when `query` (already lowercased) matches the symbol or name of a label. */
export function labelMatches(label: TokenLabel | null, query: string): boolean {
  if (!label || !query) return false;
  return label.symbol.toLowerCase().includes(query) || label.name.toLowerCase().includes(query);
}

export const ALL_TOKEN_LABELS: ReadonlyArray<{ key: string; label: TokenLabel }> = [...LABELS].map(([key, label]) => ({ key, label }));
