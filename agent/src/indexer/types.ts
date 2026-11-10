/**
 * Read-only arena event indexing contracts. The indexer parses Valtrum NEP-297 logs, persists a
 * replayable journal and a derived projection, resumes after restart, replays deterministically,
 * and rolls back provisional forks. It has NO write authority: it never submits transactions,
 * allocates rewards, signs, confirms foreign payments or releases custody. Its projections are
 * derived read models, not authority over funds, and a recorded source is a declared assertion of
 * chain state, never independently verified finality.
 *
 * Heights, amounts and on-chain integer ids are carried as decimal strings (and compared as BigInt)
 * so u64 values never lose precision through a JavaScript number.
 */

/** Identity of a block source. Source kind never upgrades recorded assertions into live evidence. */
export interface SourceIdentity {
  /** Domain/network identity, e.g. "near-testnet". Part of every dedup key and projection namespace. */
  network: string;
  sourceType: "recorded" | "live";
  /** Optional declared genesis/start-domain anchor; recorded sources may omit it. */
  genesis?: string;
  provider?: string;
  qualification?: string;
}

/** A height+hash reference to a block (height is a decimal string). */
export interface BlockRef {
  height: string;
  hash: string;
}

/** One receipt/execution-outcome envelope: its identity, success, and ordered logs. */
export interface ReceiptOutcome {
  /** Receipt or execution-outcome id; a transaction hash alone is insufficient for NEAR. */
  receiptId: string;
  /** Executing account; when present it, not a field inside the event, is the emitter identity. */
  executorId?: string;
  /** Whether the outcome succeeded; logs from a failed outcome are never accepted as state. */
  success: boolean;
  /** Ordered logs exactly as emitted; `EVENT_JSON:` lines are parsed, others are unrelated. */
  logs: string[];
}

/** A complete recorded block envelope. `network`/`contract` declare whose receipts these are. */
export interface RecordedBlock {
  network: string;
  /** Account these receipts executed on; checked against the configured contract allowlist. */
  contract: string;
  header: {
    height: string;
    hash: string;
    /** Parent block hash for linkage; null only at the declared start anchor/genesis. */
    parentHash: string | null;
    timestampMs: string;
  };
  outcomes: ReceiptOutcome[];
  /** false => receipts/logs are not fully available; the engine must not advance over it. */
  complete: boolean;
  /** Source assertion only (declared finality), never independently verified by the indexer. */
  finalizedDeclared?: boolean;
}

/** Result of asking a source for the canonical block at a height. */
export type BlockAt =
  | { kind: "block"; block: RecordedBlock }
  | { kind: "skipped" } // a legitimate NEAR height with no block
  | { kind: "incomplete" } // a block exists but its data is not fully available
  | { kind: "beyond_head" }; // the height is above the source's latest head

/** Injectable read-only source, shared by recorded replay and the qualified live adapter. */
export interface BlockSource {
  identity(): SourceIdentity;
  /** The source's declared latest and finalized heads (finality is a source assertion). */
  head(): Promise<{ latest: BlockRef | null; finalized: BlockRef | null }>;
  /** The canonical block at `height` (decimal string), or why there is none to process. */
  blockAt(height: string): Promise<BlockAt>;
}

/** Persisted indexer configuration. Reopening a store under a conflicting config is rejected. */
export interface IndexerConfig {
  /** Live provider/genesis binding. Missing on historical recorded stores. */
  sourceFingerprint?: string;
  network: string;
  /** Allowlisted originating/executing contract accounts. */
  contracts: string[];
  /** NEP-297 standard name accepted as arena events. */
  standard: string;
  /** Supported envelope versions. */
  supportedVersions: string[];
  /** Persisted store schema version. */
  schemaVersion: string;
  /** Projection reducer version; a change means the projection may differ and is re-derived. */
  reducerVersion: string;
  /** Hash of the block that precedes the first processed block (null = declared genesis start). */
  anchorHash: string | null;
  /** Height of the first block to process (decimal string). */
  anchorHeight: string;
  /** How many trailing provisional blocks are retained for reorg rollback. */
  retainedDepth: number;
}

/**
 * Events the reducer models, by emitting standard. The arena standard is `IndexerConfig.standard`
 * (`valtrum`); the others are fixed companion standards emitted by the backing and payout contracts.
 * Any other event from an allowlisted emitter is reported as `unknown_event` (a degraded status),
 * never silently dropped.
 */
import type { RoundEventName, RoundEvidenceV1 } from "./round-events.js";

export type SupportedEventName = RoundEventName
  | "lifecycle_battle_created"
  | "audit_updated"
  | "lifecycle_deposit"
  | "backing_updated"
  | "lifecycle_representation_trust_changed"
  | "late_deposit_recorded"
  | "asset_suspended"
  | "asset_resumed"
  | "custody_attested"
  | "reconciliation_unresolved"
  | "operator_changed"
  | "resume_policy_changed"
  | "payout_signature_requested"
  | "payout_signature_received"
  | "payout_signature_failed"
  | "payout_state_changed";

export const SUPPORTED_EVENTS: readonly SupportedEventName[] = [
  "lifecycle_round_opened_v1", "lifecycle_round_pending_v1", "lifecycle_round_resolved_v1",
  "lifecycle_battle_created",
  "audit_updated",
  "lifecycle_deposit",
  "backing_updated",
  "lifecycle_representation_trust_changed",
  "late_deposit_recorded",
  "asset_suspended",
  "asset_resumed",
  "custody_attested",
  "reconciliation_unresolved",
  "operator_changed",
  "resume_policy_changed",
  "payout_signature_requested",
  "payout_signature_received",
  "payout_signature_failed",
  "payout_state_changed",
];

/** Companion NEP-297 standards of the Valtrum contracts, with the events each one models. */
export const BACKING_STANDARD = "valtrum_backing";
export const PAYOUT_STANDARD = "valtrum_payout";
/** Emitted by the player-policy contract; no event of it is modelled, so it is always reported. */
export const PLAYER_POLICY_STANDARD = "valtrum_player_policy";
export const COMPANION_STANDARDS: readonly string[] = [BACKING_STANDARD, PAYOUT_STANDARD, PLAYER_POLICY_STANDARD];

/** Where an accepted event came from. The emitter is the receipt executor, never an event field. */
export interface EventProvenance {
  network: string;
  contract: string;
  blockHash: string;
  blockHeight: string;
  blockTimestampMs: string;
  receiptId: string;
  /** Position of the receipt/outcome within its block; part of the canonical order, not the key. */
  outcomeIndex: number;
  logIndex: number;
  itemIndex: number;
  outcomeSuccess: boolean;
}

interface EventCommon {
  /** Stable identity: network | contract | receipt | logIndex | itemIndex. */
  dedupKey: string;
  provenance: EventProvenance;
  /** Digest of the normalized payload; identical key with a different digest is a conflict. */
  payloadDigest: string;
}

export type AcceptedEvent =
  | (EventCommon & { name: RoundEventName; battleId: string; round: RoundEvidenceV1 })
  | (EventCommon & { name: "lifecycle_battle_created"; battleId: string; creator: string })
  | (EventCommon & {
      name: "audit_updated";
      battleId: string;
      community: string;
      result: "pass" | "reject" | "pending";
      evidenceHash: string;
      expiresAtMs: string | null;
    })
  | (EventCommon & {
      name: "lifecycle_deposit";
      battleId: string;
      community: string;
      accountId: string;
      amount: string;
    })
  | (EventCommon & {
      name: "backing_updated";
      battleId: string;
      community: string;
      approved: boolean;
      evidenceHash: string | null;
      expiresAtMs: string | null;
    })
  | (EventCommon & { name: "lifecycle_representation_trust_changed"; representation: string; trusted: boolean })
  | (EventCommon & { name: "late_deposit_recorded"; battleId: string; beneficiary: string; refundAddress: string; units: string })
  | (EventCommon & { name: "asset_suspended"; reason: string })
  | (EventCommon & { name: "asset_resumed"; by: string; reorg: boolean; deficit: boolean; stillSuspended: boolean })
  | (EventCommon & {
      name: "custody_attested";
      sequence: string;
      sourceBlockNumber: string;
      balance: string;
      required: string | null;
      covered: boolean;
    })
  | (EventCommon & { name: "reconciliation_unresolved"; holder: string; requestId: string })
  | (EventCommon & { name: "operator_changed"; previous: string | null; next: string | null; by: string })
  | (EventCommon & { name: "resume_policy_changed"; previous: string; next: string; by: string })
  | (EventCommon & {
      name: "payout_signature_requested";
      backing: string;
      holder: string;
      requestId: string;
      payloadHash: string;
      maxFeePerGas: string;
      nonce: string;
    })
  | (EventCommon & { name: "payout_signature_received"; backing: string; holder: string; requestId: string; txHash: string; maxFeePerGas: string })
  | (EventCommon & { name: "payout_signature_failed"; backing: string; holder: string; requestId: string; maxFeePerGas: string })
  | (EventCommon & {
      name: "payout_state_changed";
      backing: string;
      holder: string;
      requestId: string;
      from: string | null;
      to: string;
      reason: string | null;
    });

/** Why a log/item was not accepted as known state. Retained for diagnosis, never applied. */
export type DiagnosticReason =
  | "unrelated_log" // not an EVENT_JSON line
  | "other_standard" // a different NEP-297 standard
  | "malformed_envelope" // EVENT_JSON prefix but the envelope is not valid/complete
  | "unsupported_version" // known standard, unsupported version
  | "unknown_event" // supported standard/version, unknown event name
  | "wrong_emitter" // the executing account is not in the allowlist
  | "failed_outcome" // the receipt outcome did not succeed
  | "unsafe_numeric" // a numeric value is a non-integer or otherwise unsafe
  | "malformed_payload" // a supported event with an invalid payload
  | "conflict_payload"; // the same event identity reappeared with a different payload

/** A quarantined record: retained with bounded raw provenance; it pauses, never silently vanishes. */
export interface DiagnosticRecord {
  dedupKey: string | null;
  reason: DiagnosticReason;
  provenance: EventProvenance;
  /** Standard/version/event when they could be read, for triage. */
  standard?: string;
  version?: string;
  event?: string;
  /** Bounded raw log text for diagnosis; never includes secrets (events carry none). */
  rawLog: string;
}

export type IndexerHealthStatus = "healthy" | "pending" | "degraded" | "reconciliation_required";

/** Operational health and provenance of the indexer; it suspends its own claims, not any contract. */
export interface IndexerHealth {
  status: IndexerHealthStatus;
  reason: string;
  source: SourceIdentity;
  /** Covered range on the processed (provisional) chain. */
  processedHead: BlockRef | null;
  finalizedHead: BlockRef | null;
  /** Count of quarantined diagnostics that require attention. */
  quarantined: number;
  /** Timestamp of the most recent successful sync (ms since epoch, from an injected clock). */
  lastSyncMs: number | null;
}
