import { ONE, compareDecimal, formatDecimal, parseDecimal } from "./decimal.js";

/**
 * GoPlus Token Security normalization following docs/goplus-audit.md.
 * Pure functions: no I/O, no truthiness coercion, unknown stays unknown.
 */

export type Tri = "true" | "false" | "unknown";

export const CRITICAL_FLAGS = ["is_honeypot", "cannot_sell_all", "cannot_buy"] as const;
export const TAX_FIELDS = ["buy_tax", "sell_tax", "transfer_tax"] as const;
/** Privilege signals: recorded, admissibility is OPEN. */
export const PRIVILEGE_FLAGS = [
  "slippage_modifiable",
  "personal_slippage_modifiable",
  "transfer_pausable",
  "owner_change_balance",
  "is_blacklisted",
  "is_whitelisted",
  "is_mintable",
] as const;

export type CriticalFlag = (typeof CRITICAL_FLAGS)[number];
export type TaxField = (typeof TAX_FIELDS)[number];
export type PrivilegeFlag = (typeof PRIVILEGE_FLAGS)[number];

export interface FlagState {
  state: Tri;
  raw: string | null;
  reason: string;
}

export type TaxState =
  | { kind: "known"; fraction: string; entirelyTaxed: boolean; raw: string }
  | { kind: "unknown"; raw: string | null; reason: string }
  | { kind: "malformed"; raw: string; reason: string };

export type OwnerState =
  | { kind: "none" } // empty owner_address: may mean no owner, kept distinct from unknown
  | { kind: "address"; address: string }
  | { kind: "unknown" };

export type SourceStatus =
  | { status: "ok" }
  | { status: "unsupported"; reason: string }
  | { status: "empty"; reason: string }
  | { status: "error"; reason: string }
  | { status: "wrong_source"; reason: string };

export interface Finding {
  field: string;
  severity: "critical" | "unknown" | "info";
  reason: string;
}

export interface NormalizedGoPlus {
  source: SourceStatus;
  critical: Record<CriticalFlag, FlagState>;
  tax: Record<TaxField, TaxState>;
  privileges: Record<PrivilegeFlag, FlagState>;
  context: {
    isOpenSource: FlagState;
    isProxy: FlagState;
    hiddenOwner: FlagState;
    canTakeBackOwnership: FlagState;
    isInDex: FlagState;
    owner: OwnerState;
    dex: unknown;
  };
  findings: Finding[];
}

/** What was asked of the provider; the response must match it. */
export interface GoPlusQuery {
  chainId: string;
  token: string;
}

export interface RawGoPlusResponse {
  query: GoPlusQuery;
  providerVersion: string;
  queriedAt: string; // ISO time
  httpStatus: number;
  rawText: string;
  body: unknown;
}

export function normalizeFlag(value: unknown): FlagState {
  if (value === "1") return { state: "true", raw: "1", reason: "reported true" };
  if (value === "0") return { state: "false", raw: "0", reason: "reported false" };
  if (value === undefined || value === null) {
    return { state: "unknown", raw: null, reason: "absent or null" };
  }
  return {
    state: "unknown",
    raw: typeof value === "string" ? value : JSON.stringify(value),
    reason: "unexpected representation",
  };
}

export function normalizeTax(value: unknown): TaxState {
  if (value === undefined || value === null) {
    return { kind: "unknown", raw: null, reason: "absent or null" };
  }
  if (typeof value !== "string") {
    return { kind: "malformed", raw: JSON.stringify(value), reason: "not a decimal string" };
  }
  if (value === "") return { kind: "unknown", raw: "", reason: "empty value is not zero" };
  const d = parseDecimal(value);
  if (!d) return { kind: "malformed", raw: value, reason: "not a plain decimal fraction" };
  const cmp = compareDecimal(d, ONE);
  if (cmp > 0) return { kind: "malformed", raw: value, reason: "fraction above 1" };
  return { kind: "known", fraction: formatDecimal(d), entirelyTaxed: cmp === 0, raw: value };
}

function normalizeOwner(value: unknown): OwnerState {
  if (value === undefined || value === null) return { kind: "unknown" };
  if (typeof value !== "string") return { kind: "unknown" };
  return value === "" ? { kind: "none" } : { kind: "address", address: value };
}

function sourceStatus(raw: RawGoPlusResponse): SourceStatus {
  if (raw.httpStatus < 200 || raw.httpStatus >= 300) {
    return { status: "error", reason: `HTTP ${raw.httpStatus}` };
  }
  const body = raw.body;
  if (typeof body !== "object" || body === null) {
    return { status: "error", reason: "response is not a JSON object" };
  }
  const { code, message, result } = body as { code?: unknown; message?: unknown; result?: unknown };
  if (code === 2022) {
    return { status: "unsupported", reason: `chain not supported by provider: ${String(message)}` };
  }
  if (code !== 1) return { status: "error", reason: `provider code ${String(code)}: ${String(message)}` };
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return { status: "empty", reason: "no result object" };
  }
  const entries = Object.entries(result as Record<string, unknown>);
  if (entries.length === 0) return { status: "empty", reason: "empty result: no token evidence" };
  const want = raw.query.token.toLowerCase();
  if (entries.length !== 1 || entries[0]![0].toLowerCase() !== want) {
    return { status: "wrong_source", reason: "result does not belong to the queried token" };
  }
  if (typeof entries[0]![1] !== "object" || entries[0]![1] === null) {
    return { status: "empty", reason: "token entry is not an object" };
  }
  return { status: "ok" };
}

/** Result entry for the queried token, or undefined if the source is not usable. */
function tokenEntry(raw: RawGoPlusResponse): Record<string, unknown> | undefined {
  const result = (raw.body as { result?: Record<string, unknown> }).result!;
  const key = Object.keys(result)[0]!;
  return result[key] as Record<string, unknown>;
}

const UNKNOWN_FLAG: FlagState = { state: "unknown", raw: null, reason: "no usable source evidence" };
const UNKNOWN_TAX: TaxState = { kind: "unknown", raw: null, reason: "no usable source evidence" };

/** Evidence placeholder when no usable provider response exists (e.g. unresolved reference mapping). */
export function unusableGoPlus(reason: string): NormalizedGoPlus {
  return allUnknown({ status: "error", reason });
}

function allUnknown(source: SourceStatus): NormalizedGoPlus {
  const rec = <K extends string, V>(keys: readonly K[], v: V) =>
    Object.fromEntries(keys.map((k) => [k, v])) as Record<K, V>;
  return {
    source,
    critical: rec(CRITICAL_FLAGS, UNKNOWN_FLAG),
    tax: rec(TAX_FIELDS, UNKNOWN_TAX),
    privileges: rec(PRIVILEGE_FLAGS, UNKNOWN_FLAG),
    context: {
      isOpenSource: UNKNOWN_FLAG,
      isProxy: UNKNOWN_FLAG,
      hiddenOwner: UNKNOWN_FLAG,
      canTakeBackOwnership: UNKNOWN_FLAG,
      isInDex: UNKNOWN_FLAG,
      owner: { kind: "unknown" },
      dex: null,
    },
    findings: [
      {
        field: "source",
        severity: "unknown",
        reason: source.status === "ok" ? "" : (source as { reason: string }).reason,
      },
    ],
  };
}

export function normalizeGoPlus(raw: RawGoPlusResponse): NormalizedGoPlus {
  const source = sourceStatus(raw);
  if (source.status !== "ok") return allUnknown(source);
  const entry = tokenEntry(raw)!;

  const findings: Finding[] = [];
  const critical = {} as Record<CriticalFlag, FlagState>;
  for (const f of CRITICAL_FLAGS) {
    const s = normalizeFlag(entry[f]);
    critical[f] = s;
    if (s.state === "true") findings.push({ field: f, severity: "critical", reason: `${f} is true` });
    else if (s.state === "unknown") findings.push({ field: f, severity: "unknown", reason: `${f}: ${s.reason}` });
  }
  const tax = {} as Record<TaxField, TaxState>;
  for (const f of TAX_FIELDS) {
    const t = normalizeTax(entry[f]);
    tax[f] = t;
    if (t.kind === "known" && t.entirelyTaxed) {
      findings.push({ field: f, severity: "critical", reason: `${f} is exactly 1: unusable path` });
    } else if (t.kind !== "known") {
      findings.push({ field: f, severity: "unknown", reason: `${f}: ${t.reason}` });
    } else {
      findings.push({ field: f, severity: "info", reason: `${f} is ${t.fraction} (fraction)` });
    }
  }
  const privileges = {} as Record<PrivilegeFlag, FlagState>;
  for (const f of PRIVILEGE_FLAGS) {
    const s = normalizeFlag(entry[f]);
    privileges[f] = s;
    if (s.state === "unknown") findings.push({ field: f, severity: "unknown", reason: `${f}: ${s.reason}` });
    else if (s.state === "true") findings.push({ field: f, severity: "info", reason: `${f} capability reported` });
  }
  const context = {
    isOpenSource: normalizeFlag(entry.is_open_source),
    isProxy: normalizeFlag(entry.is_proxy),
    hiddenOwner: normalizeFlag(entry.hidden_owner),
    canTakeBackOwnership: normalizeFlag(entry.can_take_back_ownership),
    isInDex: normalizeFlag(entry.is_in_dex),
    owner: normalizeOwner(entry.owner_address),
    dex: entry.dex ?? null,
  };
  for (const [name, s] of [
    ["is_open_source", context.isOpenSource],
    ["is_proxy", context.isProxy],
  ] as const) {
    if (s.state === "unknown") findings.push({ field: name, severity: "unknown", reason: `${name}: ${s.reason}` });
  }
  return { source, critical, tax, privileges, context, findings };
}
