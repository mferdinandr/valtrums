/**
 * Assets the app no longer offers (D35): AI (Affair Inu) left the joinable allowlist and its backing is not trusted,
 * so it is hidden from the faucet, the token pickers, the asset search and the mascot roster. It is matched by
 * identity (the mainnet reference token and the testnet mock token), or by the faucet's symbol, never by a name
 * alone in a search. Battles that already contain it on chain still show their recorded communities.
 */
const HIDDEN_ADDRESSES = new Set([
  "0x0d4a117dccce7ba3d0a475ec9068c20c35310fd8", // AI mainnet reference (4663)
  "0x973c4e0601c03a4899b8c9643b299aaaece4ba0a", // mAI testnet mock (46630)
]);
const HIDDEN_SYMBOLS = new Set(["AI", "MAI"]);

/** True for an asset whose token or reference address is hidden. */
export function isHiddenAsset(asset: { token?: string | null; referenceToken?: string | null }): boolean {
  return [asset.token, asset.referenceToken].some((a) => !!a && HIDDEN_ADDRESSES.has(a.toLowerCase()));
}

/** True for a faucet entry whose symbol is a hidden asset (the faucet lists NEAR accounts and symbols only). */
export function isHiddenSymbol(symbol: string | null | undefined): boolean {
  return !!symbol && HIDDEN_SYMBOLS.has(symbol.trim().toUpperCase());
}
