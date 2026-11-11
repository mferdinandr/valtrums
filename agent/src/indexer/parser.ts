import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { normalizeRoundEvent } from "./round-events.js";
import {
  BACKING_STANDARD,
  COMPANION_STANDARDS,
  PAYOUT_STANDARD,
  type AcceptedEvent,
  type DiagnosticRecord,
  type EventProvenance,
  type IndexerConfig,
  type RecordedBlock,
  type SupportedEventName,
} from "./types.js";

/**
 * Validated NEP-297 parsing with receipt provenance. The emitter identity is the executing account
 * of the receipt, never a field inside the event. Integers are parsed losslessly so a u64 never
 * rounds through a JavaScript number; a non-integer numeric value is rejected, not rounded.
 */

export const EVENT_PREFIX = "EVENT_JSON:";
/** Bound the raw log we will parse; an oversized payload is quarantined, never applied. */
export const MAX_LOG_BYTES = 16 * 1024;

/** A number whose JSON source was not a plain integer; it is never silently rounded. */
interface UnsafeNumber {
  __unsafeNumber: string;
}
type JsonValue = string | boolean | null | bigint | UnsafeNumber | JsonValue[] | { [k: string]: JsonValue };

const isUnsafeNumber = (v: unknown): v is UnsafeNumber =>
  typeof v === "object" && v !== null && "__unsafeNumber" in v;

/** JSON.parse that keeps integers exact as BigInt and tags any non-integer number as unsafe. */
export function losslessParse(text: string): JsonValue {
  const reviver = (_key: string, value: unknown, context?: { source?: string }): unknown => {
    if (typeof value !== "number") return value;
    const src = context?.source;
    if (typeof src === "string") return /^-?\d+$/.test(src) ? BigInt(src) : { __unsafeNumber: src };
    // Defensive fallback for runtimes without source access: only safe integers are trustworthy.
    return Number.isSafeInteger(value) ? BigInt(value) : { __unsafeNumber: String(value) };
  };
  return JSON.parse(text, reviver) as JsonValue;
}

const hex = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sort((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** Recompute the normalized payload commitment when validating persisted journal entries. */
export function eventPayloadDigest(event: AcceptedEvent): string {
  const { dedupKey: _key, provenance: _provenance, payloadDigest: _digest, ...payload } = event;
  return hex(canonicalJson(payload));
}

export interface ParsedBlock {
  accepted: AcceptedEvent[];
  diagnostics: DiagnosticRecord[];
}

class PayloadError extends Error {
  constructor(
    public readonly reason: "unsafe_numeric" | "malformed_payload",
    message: string,
  ) {
    super(message);
  }
}

const ACCOUNT_MAX = 64;
const STRING_MAX = 256;

function reqString(obj: Record<string, JsonValue>, key: string, max = STRING_MAX): string {
  const v = obj[key];
  if (isUnsafeNumber(v)) throw new PayloadError("unsafe_numeric", `${key} is an unsafe number`);
  if (typeof v !== "string") throw new PayloadError("malformed_payload", `${key} must be a string`);
  if (v.length === 0 || v.length > max) throw new PayloadError("malformed_payload", `${key} has an invalid length`);
  return v;
}

/** A non-negative integer field emitted as a JSON number; returned as a decimal string. */
function reqIntString(obj: Record<string, JsonValue>, key: string): string {
  const v = obj[key];
  if (isUnsafeNumber(v)) throw new PayloadError("unsafe_numeric", `${key} is not an integer`);
  if (typeof v === "bigint") {
    if (v < 0n) throw new PayloadError("malformed_payload", `${key} must be non-negative`);
    return v.toString();
  }
  // A u64/U128 may also be emitted as a decimal string; accept a canonical one.
  if (typeof v === "string") {
    if (!/^(0|[1-9][0-9]*)$/.test(v)) throw new PayloadError("malformed_payload", `${key} must be a non-negative integer`);
    return v;
  }
  throw new PayloadError("malformed_payload", `${key} must be an integer`);
}

/** Optional decimal-string / null field (e.g. `expires_at_ms`). */
function optIntString(obj: Record<string, JsonValue>, key: string): string | null {
  const v = obj[key];
  if (v === null || v === undefined) return null;
  return reqIntString(obj, key);
}

type AcceptedEventPayload = DistributiveOmit<AcceptedEvent, "dedupKey" | "provenance" | "payloadDigest">;
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

function reqBool(obj: Record<string, JsonValue>, key: string): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") throw new PayloadError("malformed_payload", `${key} must be a boolean`);
  return v;
}

function optString(obj: Record<string, JsonValue>, key: string, max = STRING_MAX): string | null {
  const v = obj[key];
  if (v === null || v === undefined) return null;
  return reqString(obj, key, max);
}

/** A 32-byte id emitted either as a JSON byte array (`[u8; 32]`) or as a hex string; returned as lowercase hex. */
function reqBytes32Hex(obj: Record<string, JsonValue>, key: string): string {
  const v = obj[key];
  if (Array.isArray(v)) {
    if (v.length !== 32 || !v.every((b) => typeof b === "bigint" && b >= 0n && b <= 255n)) {
      throw new PayloadError("malformed_payload", `${key} must be 32 bytes`);
    }
    return v.map((b) => (b as bigint).toString(16).padStart(2, "0")).join("");
  }
  const h = reqString(obj, key, 66);
  const body = h.startsWith("0x") ? h.slice(2) : h;
  if (!/^[0-9a-fA-F]{64}$/.test(body)) throw new PayloadError("malformed_payload", `${key} must be 32 bytes`);
  return body.toLowerCase();
}

/** Wire event name per standard slot -> accepted event name. Anything absent is unsupported. */
const ARENA_EVENTS: Record<string, SupportedEventName> = {
  lifecycle_round_opened_v1: "lifecycle_round_opened_v1",
  lifecycle_round_pending_v1: "lifecycle_round_pending_v1",
  lifecycle_round_resolved_v1: "lifecycle_round_resolved_v1",
  lifecycle_battle_created: "lifecycle_battle_created",
  audit_updated: "audit_updated",
  lifecycle_deposit: "lifecycle_deposit",
  lifecycle_community_added: "lifecycle_community_added",
  lifecycle_battle_cancelled: "lifecycle_battle_cancelled",
  lifecycle_refund: "lifecycle_refund",
  backing_updated: "backing_updated",
  lifecycle_representation_trust_changed: "lifecycle_representation_trust_changed",
};
const BACKING_EVENTS: Record<string, SupportedEventName> = {
  late_deposit_recorded: "late_deposit_recorded",
  asset_suspended: "asset_suspended",
  asset_resumed: "asset_resumed",
  custody_attested: "custody_attested",
  reconciliation_unresolved: "reconciliation_unresolved",
  operator_changed: "operator_changed",
  resume_policy_changed: "resume_policy_changed",
};
const PAYOUT_EVENTS: Record<string, SupportedEventName> = {
  signature_requested: "payout_signature_requested",
  signature_received: "payout_signature_received",
  signature_failed: "payout_signature_failed",
  payout_state_changed: "payout_state_changed",
};

function modelledEvent(standard: string, event: string, config: IndexerConfig): SupportedEventName | null {
  const own = (table: Record<string, SupportedEventName>): SupportedEventName | null =>
    Object.prototype.hasOwnProperty.call(table, event) ? table[event]! : null;
  if (standard === config.standard) return own(ARENA_EVENTS);
  if (standard === BACKING_STANDARD) return own(BACKING_EVENTS);
  if (standard === PAYOUT_STANDARD) return own(PAYOUT_EVENTS);
  return null;
}

function normalize(name: SupportedEventName, data: Record<string, JsonValue>): AcceptedEventPayload {
  switch (name) {
    case "lifecycle_round_opened_v1":
    case "lifecycle_round_pending_v1":
    case "lifecycle_round_resolved_v1":
      return { name, battleId: reqIntString(data, "battle_id"), round: normalizeRoundEvent(name, data) };
    case "lifecycle_battle_created":
      return { name, battleId: reqIntString(data, "battle_id"), creator: reqString(data, "creator", ACCOUNT_MAX) };
    case "audit_updated": {
      const result = reqString(data, "result", 16);
      if (result !== "pass" && result !== "reject" && result !== "pending") {
        throw new PayloadError("malformed_payload", "result must be pass, reject or pending");
      }
      return {
        name,
        battleId: reqIntString(data, "battle_id"),
        community: reqIntString(data, "community"),
        result,
        evidenceHash: reqString(data, "evidence_hash"),
        expiresAtMs: optIntString(data, "expires_at_ms"),
      };
    }
    case "lifecycle_deposit":
      return {
        name,
        battleId: reqIntString(data, "battle_id"),
        community: reqIntString(data, "community"),
        accountId: reqString(data, "account_id", ACCOUNT_MAX),
        amount: reqIntString(data, "amount"),
      };
    case "lifecycle_community_added":
      return {
        name,
        battleId: reqIntString(data, "battle_id"),
        community: reqIntString(data, "community"),
        representation: reqString(data, "representation", ACCOUNT_MAX),
        accountId: reqString(data, "account_id", ACCOUNT_MAX),
      };
    case "lifecycle_battle_cancelled":
      return { name, battleId: reqIntString(data, "battle_id") };
    case "lifecycle_refund":
      return {
        name,
        battleId: reqIntString(data, "battle_id"),
        community: reqIntString(data, "community"),
        accountId: reqString(data, "account_id", ACCOUNT_MAX),
        amount: reqIntString(data, "amount"),
      };
    case "backing_updated":
      return {
        name,
        battleId: reqIntString(data, "battle_id"),
        community: reqIntString(data, "community"),
        approved: reqBool(data, "approved"),
        evidenceHash: optString(data, "evidence_hash"),
        expiresAtMs: optIntString(data, "expires_at_ms"),
      };
    case "lifecycle_representation_trust_changed":
      return { name, representation: reqString(data, "representation", ACCOUNT_MAX), trusted: reqBool(data, "trusted") };
    case "late_deposit_recorded":
      return {
        name,
        battleId: reqIntString(data, "battle_id"),
        beneficiary: reqString(data, "beneficiary", ACCOUNT_MAX),
        refundAddress: reqString(data, "refund_address", 66),
        units: reqIntString(data, "units"),
      };
    case "asset_suspended":
      return { name, reason: reqString(data, "reason", 64) };
    case "asset_resumed":
      return {
        name,
        by: reqString(data, "by", ACCOUNT_MAX),
        reorg: reqBool(data, "reorg"),
        deficit: reqBool(data, "deficit"),
        stillSuspended: reqBool(data, "still_suspended"),
      };
    case "custody_attested":
      return {
        name,
        sequence: reqIntString(data, "sequence"),
        sourceBlockNumber: reqIntString(data, "source_block_number"),
        balance: reqIntString(data, "balance"),
        required: data.required === null || data.required === undefined ? null : reqIntString(data, "required"),
        covered: reqBool(data, "covered"),
      };
    case "reconciliation_unresolved":
      return { name, holder: reqString(data, "holder", ACCOUNT_MAX), requestId: reqBytes32Hex(data, "request_id") };
    case "operator_changed":
      return { name, previous: optString(data, "old", ACCOUNT_MAX), next: optString(data, "new", ACCOUNT_MAX), by: reqString(data, "by", ACCOUNT_MAX) };
    case "resume_policy_changed":
      return { name, previous: reqString(data, "old", 64), next: reqString(data, "new", 64), by: reqString(data, "by", ACCOUNT_MAX) };
    case "payout_signature_requested":
      return {
        name,
        backing: reqString(data, "backing", ACCOUNT_MAX),
        holder: reqString(data, "holder", ACCOUNT_MAX),
        requestId: reqBytes32Hex(data, "request_id"),
        payloadHash: reqBytes32Hex(data, "payload_hash"),
        maxFeePerGas: reqIntString(data, "max_fee_per_gas"),
        nonce: reqIntString(data, "nonce"),
      };
    case "payout_signature_received":
      return {
        name,
        backing: reqString(data, "backing", ACCOUNT_MAX),
        holder: reqString(data, "holder", ACCOUNT_MAX),
        requestId: reqBytes32Hex(data, "request_id"),
        txHash: reqBytes32Hex(data, "tx_hash"),
        maxFeePerGas: reqIntString(data, "max_fee_per_gas"),
      };
    case "payout_signature_failed":
      return {
        name,
        backing: reqString(data, "backing", ACCOUNT_MAX),
        holder: reqString(data, "holder", ACCOUNT_MAX),
        requestId: reqBytes32Hex(data, "request_id"),
        maxFeePerGas: reqIntString(data, "max_fee_per_gas"),
      };
    case "payout_state_changed":
      return {
        name,
        backing: reqString(data, "backing", ACCOUNT_MAX),
        holder: reqString(data, "holder", ACCOUNT_MAX),
        requestId: reqBytes32Hex(data, "request_id"),
        from: optString(data, "from", 64),
        to: reqString(data, "to", 64),
        reason: optString(data, "reason", 64),
      };
  }
}

/** Parse one recorded block into accepted events and quarantined diagnostics. */
export function parseBlock(block: RecordedBlock, config: IndexerConfig): ParsedBlock {
  const accepted: AcceptedEvent[] = [];
  const diagnostics: DiagnosticRecord[] = [];
  const allow = new Set(config.contracts);

  block.outcomes.forEach((outcome, outcomeIndex) => {
    const emitter = outcome.executorId ?? block.contract;
    outcome.logs.forEach((log, logIndex) => {
      if (!log.startsWith(EVENT_PREFIX)) return; // unrelated log: not an error, not stored
      const provenance: EventProvenance = {
        network: block.network,
        contract: emitter,
        blockHash: block.header.hash,
        blockHeight: block.header.height,
        blockTimestampMs: block.header.timestampMs,
        receiptId: outcome.receiptId,
        outcomeIndex,
        logIndex,
        itemIndex: 0,
        outcomeSuccess: outcome.success,
      };
      const quarantine = (reason: DiagnosticRecord["reason"], extra: Partial<DiagnosticRecord> = {}, itemIndex = 0) => {
        diagnostics.push({
          dedupKey: `${block.network}|${emitter}|${outcome.receiptId}|${logIndex}|${itemIndex}`,
          reason,
          provenance: { ...provenance, itemIndex },
          rawLog: log.slice(0, MAX_LOG_BYTES),
          ...extra,
        });
      };

      // Authenticate the emitter (the receipt executor) BEFORE parsing, size-checking or storing the
      // raw body. A log from an account outside the allowlist is never our state, so it must not be
      // able to grow quarantine with a large raw body or degrade the indexer with a malformed one: it
      // is recorded without its raw body and never degrades health.
      if (!allow.has(emitter)) return quarantine("wrong_emitter", { rawLog: "" });
      // A failed outcome's logs are not state either; record a bounded marker, never the raw body.
      if (!outcome.success) return quarantine("failed_outcome", { rawLog: "" });

      if (Buffer.byteLength(log, "utf8") > MAX_LOG_BYTES) return quarantine("malformed_payload");

      let envelope: JsonValue;
      try {
        envelope = losslessParse(log.slice(EVENT_PREFIX.length));
      } catch {
        return quarantine("malformed_envelope");
      }
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return quarantine("malformed_envelope");
      const env = envelope as Record<string, JsonValue>;
      const standard = env.standard;
      const version = env.version;
      const event = env.event;
      // A different standard's event is ignored (not ours), except the Valtrum companion standards
      // (backing, payout, player policy): from an allowlisted emitter those are state we either model
      // or report as unsupported, never silently drop.
      if (typeof standard !== "string" || (standard !== config.standard && !COMPANION_STANDARDS.includes(standard))) return;
      if (typeof version !== "string" || !config.supportedVersions.includes(version)) {
        return quarantine("unsupported_version", { standard: String(standard), version: typeof version === "string" ? version : undefined });
      }
      if (typeof event !== "string") return quarantine("malformed_envelope", { standard, version });
      // An unknown event from an allowlisted emitter is a coverage gap (the contract emits something we
      // do not model), so it degrades health rather than being silently dropped.
      const modelled = modelledEvent(standard, event, config);
      if (modelled === null) return quarantine("unknown_event", { standard, version, event });
      // The arena emitter wraps data in an array; the backing and payout emitters emit one object. Both
      // are valid NEP-297 `data`; a single object is one item at index 0.
      const dataArr = Array.isArray(env.data) ? env.data : standard !== config.standard && env.data && typeof env.data === "object" ? [env.data] : null;
      if (!dataArr) return quarantine("malformed_envelope", { standard, version, event });

      dataArr.forEach((item, itemIndex) => {
        const tag = { standard, version, event };
        if (!item || typeof item !== "object" || Array.isArray(item)) return quarantine("malformed_payload", tag, itemIndex);
        try {
          const normalized = normalize(modelled, item as Record<string, JsonValue>);
          const prov: EventProvenance = { ...provenance, itemIndex };
          accepted.push({
            ...normalized,
            dedupKey: `${block.network}|${emitter}|${outcome.receiptId}|${logIndex}|${itemIndex}`,
            provenance: prov,
            payloadDigest: hex(canonicalJson(normalized)),
          } as AcceptedEvent);
        } catch (err) {
          const reason = err instanceof PayloadError ? err.reason : "malformed_payload";
          quarantine(reason, tag, itemIndex);
        }
      });
    });
  });

  return { accepted, diagnostics };
}
