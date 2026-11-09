import type { Reason } from "./decision.js";

/**
 * One bounded, secret-free view of per-field audit reasons, shared by the lifecycle pass log,
 * the archived-report read model (MCP, terminal, HTTP) and the plain-text formatter. Only the
 * reason code and the field/pool it names are carried; the free-text message (which can quote
 * provider output) is deliberately not part of the log shape. Text and codes only: it never
 * influences an approval decision.
 */
export interface ReasonSummary {
  code: string;
  /** Field, flag or pool the reason is about, when the reason names one. */
  field: string | null;
  /** False when the code is not one this build emits; the code is still surfaced as-is. */
  known: boolean;
}

export const KNOWN_REASON_CODES: readonly string[] = [
  "critical",
  "unknown_field",
  "wrong_source",
  "reference_mismatch",
  "reference_unregistered",
  "reference_conflict",
  "tax_policy_unresolved",
  "tax_above_limit",
  "admin_policy_unresolved",
  "admin_privilege_not_renounced",
  "ownership_unknown",
];

/** Families built from a provider status or a liquidity code: `source_<status>` and `lp_<code>`. */
export const KNOWN_REASON_PREFIXES: readonly string[] = ["source_", "lp_"];

/** Longest code or field copied into a summary; longer values are cut so a log line stays bounded. */
export const MAX_REASON_TEXT = 96;
/** Most reasons carried per summary list. */
export const MAX_REASON_SUMMARIES = 32;

export function isKnownReasonCode(code: string): boolean {
  return (
    KNOWN_REASON_CODES.includes(code) ||
    KNOWN_REASON_PREFIXES.some((p) => code.length > p.length && code.startsWith(p))
  );
}

const bound = (s: string): string => (s.length > MAX_REASON_TEXT ? `${s.slice(0, MAX_REASON_TEXT)}...` : s);

/** Same order as `reasons`; an unknown code is flagged, never dropped. */
export function summarizeReasons(reasons: readonly Reason[]): { reasons: ReasonSummary[]; truncated: boolean } {
  const out = reasons.slice(0, MAX_REASON_SUMMARIES).map((r) => ({
    code: bound(r.code),
    field: r.field ? bound(r.field) : null,
    known: isKnownReasonCode(r.code),
  }));
  return { reasons: out, truncated: reasons.length > MAX_REASON_SUMMARIES };
}
