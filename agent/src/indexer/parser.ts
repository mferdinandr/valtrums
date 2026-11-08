import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  SUPPORTED_EVENTS,
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

type AcceptedEventPayload =
  | { name: "lifecycle_battle_created"; battleId: string; creator: string }
  | { name: "audit_updated"; battleId: string; community: string; result: "pass" | "reject" | "pending"; evidenceHash: string; expiresAtMs: string | null }
  | { name: "lifecycle_deposit"; battleId: string; community: string; accountId: string; amount: string };

function normalize(name: SupportedEventName, data: Record<string, JsonValue>): AcceptedEventPayload {
  switch (name) {
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
  }
}

const isSupported = (name: string): name is SupportedEventName => (SUPPORTED_EVENTS as readonly string[]).includes(name);

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
      if (standard !== config.standard) return; // a different standard's event: ignored, not ours
      if (typeof version !== "string" || !config.supportedVersions.includes(version)) {
        return quarantine("unsupported_version", { standard: String(standard), version: typeof version === "string" ? version : undefined });
      }
      if (typeof event !== "string") return quarantine("malformed_envelope", { standard: config.standard, version });
      const dataArr = env.data;
      if (!Array.isArray(dataArr)) return quarantine("malformed_envelope", { standard: config.standard, version, event });

      dataArr.forEach((item, itemIndex) => {
        const tag = { standard: config.standard, version, event };
        if (!isSupported(event)) return quarantine("unknown_event", tag, itemIndex);
        if (!allow.has(emitter)) return quarantine("wrong_emitter", tag, itemIndex);
        if (!outcome.success) return quarantine("failed_outcome", tag, itemIndex);
        if (!item || typeof item !== "object" || Array.isArray(item)) return quarantine("malformed_payload", tag, itemIndex);
        try {
          const normalized = normalize(event, item as Record<string, JsonValue>);
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
