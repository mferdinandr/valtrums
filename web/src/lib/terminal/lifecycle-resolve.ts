// Resolves the token references of a `create_battle` intent through the backend asset registry search
// (`/api/arena/v1/assets`). An address is only ever taken from a registry entry; a reference that matches no entry,
// or more than one, is a clarifying question. Nothing here reads model output as an address.

/** A display name for a token (identity is still chainId + address). */
export interface AssetLabel {
  symbol: string;
  name: string;
  kind: "testnet-mock" | "mainnet-reference";
}

export interface RegistryAsset {
  chainId: string;
  token: string;
  referenceChainId: string;
  referenceToken: string;
  assetKey: string;
  registryVersion: string;
  /** Curated display names for the token and its mainnet reference; null or absent when none is curated. */
  label?: AssetLabel | null;
  referenceLabel?: AssetLabel | null;
}

/** Backend search by text (`q`). The registry matches `chainId:token` and the reference token as substrings. */
export type AssetSearch = (q: string) => Promise<RegistryAsset[]>;

export type ResolvedAsset = { ref: string; asset: RegistryAsset };
export type ResolveResult =
  | { ok: true; assets: ResolvedAsset[] }
  | { ok: false; question: string; ref: string };

/** `0x…` (6 to 40 hex digits, a prefix is allowed) with an optional `chainId:`. Anything else cannot be searched by the registry. */
const ADDRESS_REF = /^(?:([1-9][0-9]{0,19}):)?(0x[0-9a-fA-F]{6,40})$/;

/** `$CASHCAT`, `cashcat` or `Mock CASHCAT`: a plain name, symbol with optional `$`. */
const NAME_REF = /^\$?([A-Za-z][A-Za-z0-9 _.-]{0,39})$/;

const norm = (v: string) => v.trim().replace(/^\$/, "").toLowerCase();
const namesOf = (a: RegistryAsset): string[] =>
  [a.label, a.referenceLabel].flatMap((l) => (l ? [norm(l.symbol), norm(l.name)] : []));
const shown = (a: RegistryAsset) => a.label?.symbol ?? a.referenceLabel?.symbol ?? a.assetKey;

async function resolveAddress(ref: string, m: RegExpExecArray, search: AssetSearch): Promise<{ ok: true; asset: RegistryAsset } | { ok: false; question: string }> {
  const chain = m[1];
  const token = m[2]!.toLowerCase();
  let found: RegistryAsset[];
  try {
    found = await search(chain ? `${chain}:${token}` : token);
  } catch {
    return { ok: false, question: `The asset registry could not be searched for "${ref}". Try again in a moment.` };
  }
  const matches = found.filter((a) => a.token.toLowerCase().startsWith(token) && (!chain || a.chainId === chain));
  if (matches.length === 0) return { ok: false, question: `"${ref}" is not in the asset registry. Check the address; only registered tokens can compete.` };
  if (matches.length > 1) return { ok: false, question: `"${ref}" matches ${matches.length} registry assets. Give the full address (and chainId:) to pick one.` };
  return { ok: true, asset: matches[0]! };
}

/**
 * A name is only accepted when it equals (case-insensitively) the curated symbol or name of exactly one registry
 * entry, found by the backend search. The address still comes from that entry; a name never creates one.
 */
async function resolveName(ref: string, name: string, search: AssetSearch): Promise<{ ok: true; asset: RegistryAsset } | { ok: false; question: string }> {
  let found: RegistryAsset[];
  try {
    found = await search(norm(name));
  } catch {
    return { ok: false, question: `The asset registry could not be searched for "${ref}". Try again in a moment.` };
  }
  const wanted = norm(name);
  const matches = found.filter((a) => namesOf(a).includes(wanted));
  if (matches.length === 1) return { ok: true, asset: matches[0]! };
  if (matches.length > 1) {
    return { ok: false, question: `"${ref}" matches ${matches.length} registry assets (${matches.map(shown).join(", ")}). Give the token's 0x address to pick one.` };
  }
  return { ok: false, question: `I could not find "${ref}" in the asset registry. Use a registered token name such as ${found.length ? shown(found[0]!) : "CASHCAT"}, or give the token's 0x address (optionally chainId:0x…).` };
}

export async function resolveAssetRefs(refs: readonly string[], search: AssetSearch): Promise<ResolveResult> {
  const out: ResolvedAsset[] = [];
  for (const ref of refs) {
    const trimmed = ref.trim();
    const addr = ADDRESS_REF.exec(trimmed);
    const name = addr ? null : NAME_REF.exec(trimmed);
    if (!addr && !name) {
      return { ok: false, ref, question: `I could not resolve "${ref}". Give a registered token name such as CASHCAT, or the token's 0x address (optionally chainId:0x…).` };
    }
    const r = addr ? await resolveAddress(ref, addr, search) : await resolveName(ref, name![1]!, search);
    if (!r.ok) return { ok: false, ref, question: r.question };
    out.push({ ref, asset: r.asset });
  }
  const keys = new Set(out.map((r) => r.asset.assetKey));
  if (keys.size !== out.length) {
    const dup = out.find((r, i) => out.findIndex((o) => o.asset.assetKey === r.asset.assetKey) !== i)!;
    return { ok: false, ref: dup.ref, question: `"${dup.ref}" resolves to an asset that is already listed. Each community must be a different token.` };
  }
  return { ok: true, assets: out };
}
