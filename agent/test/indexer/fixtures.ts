// FIXTURE-ONLY: synthetic NEP-297 logs and recorded blocks with declared (not verified) finality.
import { RECORDED_SCHEMA, type RecordedChainFile } from "../../src/indexer/recorded-source.js";
import type { BlockRef, IndexerConfig, ReceiptOutcome, RecordedBlock } from "../../src/indexer/types.js";

export const NETWORK = "near-testnet";
export const CONTRACT = "arena.testnet";

export const config = (over: Partial<IndexerConfig> = {}): IndexerConfig => ({
  network: NETWORK,
  contracts: [CONTRACT],
  standard: "valtrum",
  supportedVersions: ["1.0.0"],
  schemaVersion: "indexer-v1",
  reducerVersion: "projection-v1",
  anchorHash: null,
  anchorHeight: "1",
  retainedDepth: 64,
  ...over,
});

/** A NEP-297 `EVENT_JSON:` line with a single data item, exactly as the arena emitter produces. */
export const emitLog = (event: string, data: unknown, opts: { standard?: string; version?: string } = {}): string =>
  `EVENT_JSON:${JSON.stringify({ standard: opts.standard ?? "valtrum", version: opts.version ?? "1.0.0", event, data: [data] })}`;

/** Lets a test inject a raw data literal (e.g. a u64 beyond Number.MAX_SAFE_INTEGER). */
export const emitRaw = (event: string, rawDataJson: string, opts: { standard?: string; version?: string } = {}): string =>
  `EVENT_JSON:{"standard":"${opts.standard ?? "valtrum"}","version":"${opts.version ?? "1.0.0"}","event":"${event}","data":[${rawDataJson}]}`;

export const created = (battleId: number | string, creator = "alice.testnet") =>
  emitLog("lifecycle_battle_created", { battle_id: battleId, creator });

export const auditUpdated = (
  battleId: number | string,
  community: number,
  result: "pass" | "reject" | "pending",
  evidenceHash = "a".repeat(64),
  expiresAtMs: string | null = "1799999999000",
) => emitLog("audit_updated", { battle_id: battleId, community, result, evidence_hash: evidenceHash, expires_at_ms: expiresAtMs });

export const deposit = (battleId: number | string, community: number, accountId: string, amount: string) =>
  emitLog("lifecycle_deposit", { battle_id: battleId, community, account_id: accountId, amount });

export const outcome = (receiptId: string, logs: string[], over: Partial<ReceiptOutcome> = {}): ReceiptOutcome => ({
  receiptId,
  success: true,
  logs,
  ...over,
});

let autoHash = 0;
export interface BlockOver {
  height: string;
  outcomes?: ReceiptOutcome[];
  hash?: string;
  parentHash?: string | null;
  timestampMs?: string;
  network?: string;
  contract?: string;
  complete?: boolean;
  finalizedDeclared?: boolean;
}
export const block = (over: BlockOver): RecordedBlock => ({
  network: over.network ?? NETWORK,
  contract: over.contract ?? CONTRACT,
  header: {
    height: over.height,
    hash: over.hash ?? `h${over.height}-${autoHash++}`,
    parentHash: over.parentHash ?? null,
    timestampMs: over.timestampMs ?? `${1_700_000_000_000 + Number(over.height) * 1000}`,
  },
  outcomes: over.outcomes ?? [],
  complete: over.complete ?? true,
  finalizedDeclared: over.finalizedDeclared,
});

/** Build a parent-linked chain of blocks from per-height specs. */
export const linked = (
  specs: { height: string; outcomes: ReceiptOutcome[]; hash?: string }[],
  anchorHash: string | null = null,
): RecordedBlock[] => {
  let parent = anchorHash;
  return specs.map((s) => {
    const b = block({ height: s.height, outcomes: s.outcomes, hash: s.hash ?? `blk${s.height}`, parentHash: parent });
    parent = b.header.hash;
    return b;
  });
};

/** Wrap blocks in a recorded chain file with an optional declared finalized height. */
export const chainFile = (
  blocks: RecordedBlock[],
  opts: { finalizedHeight?: string; latest?: BlockRef | null; skipped?: string[]; incomplete?: string[]; network?: string } = {},
): RecordedChainFile => {
  const last = blocks[blocks.length - 1];
  const latest = opts.latest !== undefined ? opts.latest : last ? { height: last.header.height, hash: last.header.hash } : null;
  const fin = opts.finalizedHeight ? blocks.find((b) => b.header.height === opts.finalizedHeight) : undefined;
  return {
    schema: RECORDED_SCHEMA,
    identity: { network: opts.network ?? NETWORK, sourceType: "recorded" },
    latest,
    finalized: fin ? { height: fin.header.height, hash: fin.header.hash } : null,
    blocks,
    skippedHeights: opts.skipped,
    incompleteHeights: opts.incomplete,
  };
};

/** A companion-standard line (`valtrum_backing`, `valtrum_payout`): these contracts emit `data` as ONE object, not an array. */
export const emitObject = (standard: string, event: string, data: unknown, version = "1.0.0"): string =>
  `EVENT_JSON:${JSON.stringify({ standard, version, event, data })}`;
