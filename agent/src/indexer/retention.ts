import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { StoreState, StoredBlock } from "./store.js";

/**
 * Retention by checkpoint and prune (owner decision on #109). Finalized blocks older than a
 * configurable depth behind the finalized head are folded into one hashed checkpoint and dropped, so
 * block storage cannot reach its hard limit. The checkpoint is a SUMMARY, not raw history: it commits
 * to the pruned range (heights, hashes, parent links) and to the events that range produced, but the
 * pruned block headers themselves are gone.
 *
 * What pruning never touches:
 * - provisional blocks (only finalized blocks are candidates);
 * - the journal, which carries the deduplication keys (`dedupKey` + `payloadDigest`) that stop a
 *   duplicate allocation or payment, and the events the projection is replayed from;
 * - any block that holds conflict or integrity evidence (pruning stops below the earliest such block);
 * - the finalized head block, so restart can always verify the finalized cursor and its ancestry.
 */

/** Default number of finalized blocks kept behind the finalized head. An agent choice (assumption). */
export const DEFAULT_FINALIZED_RETENTION_DEPTH = 10_000;

/** Parse a retention depth from a flag or environment value; unset means the default. */
export function parseRetentionDepth(raw: string | undefined, name = "INDEXER_RETENTION_DEPTH"): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_FINALIZED_RETENTION_DEPTH;
  if (!/^[1-9][0-9]{0,8}$/.test(value)) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

export interface RetentionCheckpoint {
  /** Always `summary`: a hashed summary of pruned history, never the history itself. */
  kind: "summary";
  note: string;
  /** The last pruned block (highest pruned height). The first retained block's parent must be this hash. */
  height: string;
  hash: string;
  parentHash: string | null;
  /** Total blocks folded into this checkpoint across every prune. */
  prunedBlocks: number;
  /** Events at or below `height`; their dedup records stay in the journal. */
  prunedEvents: number;
  /** SHA-256 over the sorted `dedupKey:payloadDigest` of those events; re-verified on every load. */
  eventsDigest: string;
  /** SHA-256 commitment chaining the previous checkpoint digest, the pruned headers and `eventsDigest`. */
  digest: string;
}

export const CHECKPOINT_NOTE =
  "Hashed summary of pruned finalized history (heights, hashes, parent links and event keys). Not raw history: pruned block headers are not retained.";

const hex = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

/** Digest of the dedup records of every journal event at or below `height`. */
export function eventsDigestUpTo(journal: StoreState["journal"], height: bigint): { count: number; digest: string } {
  const keys = journal
    .filter((e) => BigInt(e.provenance.blockHeight) <= height)
    .map((e) => `${e.dedupKey}:${e.payloadDigest}`)
    .sort();
  return { count: keys.length, digest: hex(JSON.stringify(keys)) };
}

/**
 * Prune finalized blocks older than `depth` (the number of finalized blocks to keep, at least one),
 * returning how many were dropped. Mutates `state`; the caller commits it.
 */
export function pruneFinalized(state: StoreState, depth: number): number {
  if (!Number.isSafeInteger(depth) || depth < 1) throw new Error("finalized retention depth must be a positive safe integer");
  const finalized = state.blocks.filter((b) => b.finalized);
  let candidates = finalized.slice(0, Math.max(0, finalized.length - depth));
  if (candidates.length === 0) return 0;

  // Stop below the earliest block that still holds conflict or integrity evidence.
  const evidence = new Set<string>([
    ...state.conflictBlocks,
    ...state.diagnosticOverflowBlocks,
    ...state.diagnostics.map((d) => d.provenance.blockHash),
  ]);
  const firstEvidence = candidates.findIndex((b) => evidence.has(b.hash));
  if (firstEvidence >= 0) candidates = candidates.slice(0, firstEvidence);
  if (candidates.length === 0) return 0;

  const last = candidates[candidates.length - 1]!;
  const ev = eventsDigestUpTo(state.journal, BigInt(last.height));
  const previous = state.checkpoint;
  const digest = hex(
    JSON.stringify({
      previous: previous?.digest ?? null,
      blocks: candidates.map((b: StoredBlock) => [b.height, b.hash, b.parentHash, b.timestampMs]),
      eventsDigest: ev.digest,
    }),
  );
  state.checkpoint = {
    kind: "summary",
    note: CHECKPOINT_NOTE,
    height: last.height,
    hash: last.hash,
    parentHash: last.parentHash,
    prunedBlocks: (previous?.prunedBlocks ?? 0) + candidates.length,
    prunedEvents: ev.count,
    eventsDigest: ev.digest,
    digest,
  };
  const drop = new Set(candidates.map((b) => b.hash));
  state.blocks = state.blocks.filter((b) => !drop.has(b.hash));
  return candidates.length;
}
