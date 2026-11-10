// Resolves the token references of a `create_battle` intent through the backend asset registry search
// (`/api/arena/v1/assets`). An address is only ever taken from a registry entry; a reference that matches no entry,
// or more than one, is a clarifying question. Nothing here reads model output as an address.

export interface RegistryAsset {
  chainId: string;
  token: string;
  referenceChainId: string;
  referenceToken: string;
  assetKey: string;
  registryVersion: string;
}

/** Backend search by text (`q`). The registry matches `chainId:token` and the reference token as substrings. */
export type AssetSearch = (q: string) => Promise<RegistryAsset[]>;

export type ResolvedAsset = { ref: string; asset: RegistryAsset };
export type ResolveResult =
  | { ok: true; assets: ResolvedAsset[] }
  | { ok: false; question: string; ref: string };

/** `0x…` (6 to 40 hex digits, a prefix is allowed) with an optional `chainId:`. Anything else cannot be searched by the registry. */
const ADDRESS_REF = /^(?:([1-9][0-9]{0,19}):)?(0x[0-9a-fA-F]{6,40})$/;

export async function resolveAssetRefs(refs: readonly string[], search: AssetSearch): Promise<ResolveResult> {
  const out: ResolvedAsset[] = [];
  for (const ref of refs) {
    const m = ADDRESS_REF.exec(ref.trim());
    if (!m) {
      return { ok: false, ref, question: `I could not resolve "${ref}". The registry lists tokens by address, so give the token's 0x address (optionally chainId:0x…).` };
    }
    const chain = m[1];
    const token = m[2]!.toLowerCase();
    let found: RegistryAsset[];
    try {
      found = await search(chain ? `${chain}:${token}` : token);
    } catch {
      return { ok: false, ref, question: `The asset registry could not be searched for "${ref}". Try again in a moment.` };
    }
    const matches = found.filter((a) => a.token.toLowerCase().startsWith(token) && (!chain || a.chainId === chain));
    if (matches.length === 0) return { ok: false, ref, question: `"${ref}" is not in the asset registry. Check the address; only registered tokens can compete.` };
    if (matches.length > 1) return { ok: false, ref, question: `"${ref}" matches ${matches.length} registry assets. Give the full address (and chainId:) to pick one.` };
    out.push({ ref, asset: matches[0]! });
  }
  const keys = new Set(out.map((r) => r.asset.assetKey));
  if (keys.size !== out.length) {
    const dup = out.find((r, i) => out.findIndex((o) => o.asset.assetKey === r.asset.assetKey) !== i)!;
    return { ok: false, ref: dup.ref, question: `"${dup.ref}" resolves to an asset that is already listed. Each community must be a different token.` };
  }
  return { ok: true, assets: out };
}
