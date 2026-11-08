import type { NearTransport } from "./near-client.js";
import {
  entryHash,
  resolveReference,
  validateRegistry,
  type DeclaredReference,
  type ReferenceEntry,
  type ReferenceResolution,
} from "./audit/reference.js";

/**
 * The protocol-controlled reference-token registry, read from the arena contract
 * (`get_reference_registry`). It is the single source of testnet-to-mainnet reference
 * mappings for both the audit and scoring inputs; there is no env or file override.
 * Only the arena owner can change it on-chain. An entry attests which mainnet token
 * stands in for a mock, never the mock contract's behaviour.
 */
export interface ReferenceRegistrySnapshot {
  /** On-chain registry version (decimal string); bumps on every change. */
  version: string;
  entries: readonly ReferenceEntry[];
  /** Per-entry digest keyed by `${chainId}:${lowercase token}`. */
  hashes: ReadonlyMap<string, string>;
}

export interface ReferenceRegistrySource {
  load(): Promise<ReferenceRegistrySnapshot>;
}

interface EntryView {
  chain_id: string | number;
  token_address: string;
  reference_chain_id: string | number;
  reference_address: string;
  entry_hash: string;
}

interface PageView {
  version: string | number;
  total: number;
  entries: EntryView[];
}

export const REFERENCE_REGISTRY_PAGE = 50;
/** Mirrors the contract's MAX_REFERENCE_ENTRIES; a larger total is treated as a malformed read. */
export const MAX_REFERENCE_ENTRIES = 256;

const key = (chainId: string, token: string) => `${chainId}:${token.toLowerCase()}`;

/**
 * Builds a validated snapshot. Throws (fails closed) when an entry is malformed, a token or
 * reference is duplicated, or the hash the contract reports differs from the locally computed one.
 */
export function buildSnapshot(version: string, views: readonly EntryView[]): ReferenceRegistrySnapshot {
  if (!/^(0|[1-9][0-9]*)$/.test(version)) throw new Error("reference registry version is malformed");
  const entries = views.map(
    (v): ReferenceEntry => ({
      chainId: String(v.chain_id),
      token: String(v.token_address).toLowerCase(),
      referenceChainId: String(v.reference_chain_id),
      referenceToken: String(v.reference_address).toLowerCase(),
    }),
  );
  validateRegistry(entries);
  const references = new Set<string>();
  const hashes = new Map<string, string>();
  entries.forEach((e, i) => {
    const ref = key(e.referenceChainId, e.referenceToken);
    if (references.has(ref)) throw new Error("reference registry maps one reference token to two tokens");
    references.add(ref);
    const hash = entryHash(e);
    if (views[i]!.entry_hash !== hash) throw new Error("reference registry entry hash does not match its fields");
    hashes.set(key(e.chainId, e.token), hash);
  });
  return { version, entries, hashes };
}

/** Reads every page of the on-chain registry and refuses a read that saw a concurrent change. */
export class NearReferenceRegistrySource implements ReferenceRegistrySource {
  constructor(
    private readonly contractId: string,
    private readonly transport: Pick<NearTransport, "view">,
  ) {}

  async load(): Promise<ReferenceRegistrySnapshot> {
    const views: EntryView[] = [];
    let version: string | undefined;
    let total: number | undefined;
    for (;;) {
      const page = await this.transport.view<PageView>(this.contractId, "get_reference_registry", {
        from_index: views.length,
        limit: REFERENCE_REGISTRY_PAGE,
      });
      if (!page || !Array.isArray(page.entries) || !Number.isSafeInteger(page.total)) {
        throw new Error("reference registry view returned a malformed page");
      }
      const pageVersion = String(page.version);
      if (version !== undefined && (pageVersion !== version || page.total !== total)) {
        throw new Error("reference registry changed while it was being read; retry on the next pass");
      }
      version = pageVersion;
      total = page.total;
      if (total > MAX_REFERENCE_ENTRIES) throw new Error("reference registry reports too many entries");
      views.push(...page.entries);
      if (views.length >= total || page.entries.length === 0) break;
    }
    if (views.length !== total) throw new Error("reference registry read is incomplete");
    return buildSnapshot(version, views);
  }
}

/**
 * FIXTURE-ONLY helper: a registry source over given entries, hashed locally. Production reads the
 * arena through `NearReferenceRegistrySource`; this exists for tests and offline demos.
 */
export function staticReferenceRegistry(entries: readonly ReferenceEntry[], version = "1"): ReferenceRegistrySource {
  const views = entries.map((e) => ({
    chain_id: e.chainId,
    token_address: e.token,
    reference_chain_id: e.referenceChainId,
    reference_address: e.referenceToken,
    entry_hash: entryHash(e),
  }));
  return { load: async () => buildSnapshot(version, views) };
}

/** Audit view: the same resolution the approval path applies. */
export function resolveAuditReference(
  asset: { chainId: string; token: string },
  snapshot: ReferenceRegistrySnapshot,
  declared?: DeclaredReference | null,
): ReferenceResolution {
  return resolveReference(asset, snapshot.entries, declared);
}

export type ScoringSubject =
  | { kind: "direct"; chainId: string; token: string }
  | { kind: "reference"; chainId: string; token: string; registryEntryHash: string; registryVersion: string }
  | { kind: "hold"; code: "reference_unregistered" | "reference_conflict" | "reference_mismatch"; message: string };

/**
 * Scoring view: which token's market data scores a community. A mapped mock token is scored
 * from its mainnet reference token; a token committed without a reference but registered, or
 * committed with an unregistered or different pair, is held (scoring must stay Pending).
 * Uses the same snapshot and resolution as the audit, so both read one source.
 */
export function resolveScoringSubject(
  asset: { chainId: string; token: string },
  committed: DeclaredReference | null,
  snapshot: ReferenceRegistrySnapshot,
): ScoringSubject {
  const r = resolveReference(asset, snapshot.entries, committed);
  if (r.kind === "hold") return r;
  if (r.kind === "direct") return { kind: "direct", chainId: asset.chainId, token: asset.token.toLowerCase() };
  if (committed === null) {
    return {
      kind: "hold",
      code: "reference_mismatch",
      message: "registry maps this token to a reference but the committed community mapping has none",
    };
  }
  return {
    kind: "reference",
    chainId: r.reference.chainId,
    token: r.reference.token.toLowerCase(),
    registryEntryHash: r.reference.registryEntryHash,
    registryVersion: snapshot.version,
  };
}
