import type { AuditResult } from "./decision.js";
import type { ArchivedObservation, ArchiveProvenance } from "./report-archive.js";
import type { AuditReport } from "./report.js";

/**
 * Backend read model over archived observations. It is passive: it reads the archive, computes
 * read-time freshness against an injected trusted clock, and never refreshes GoPlus, reads RPC,
 * signs or mutates anything.
 *
 * The immutable historical `result` is kept distinct from `freshness`: a `pass` recorded yesterday
 * is not approval today. Because this API does not inspect live battle or current-policy state, it
 * never asserts a current approval — `currentApproval` is always `notEstablished`.
 */

/** Read-time classification of a historical approval window. Not a current-approval claim. */
export type Freshness =
  | "fresh" // a pass whose recorded expiry has not yet elapsed at `now`
  | "expired" // a pass whose recorded expiry is at or before `now`
  | "not_applicable"; // no valid approval expiry: non-pass, or null/malformed expiry

export const CURRENT_APPROVAL = "notEstablished" as const;

export type ObservationView = {
  observationId: string;
  seq: number;
  archivedAt: string;
  provenance: ArchiveProvenance;
  domain: { arena: string; custodyDomain: string };
  attribution: { battleId: number; community: number };
  /** Immutable stored result; never rewritten into another verdict. */
  historicalResult: AuditResult;
  freshness: Freshness;
  /** This API cannot establish current approval; it never claims one from a stored pass or a TTL. */
  currentApproval: typeof CURRENT_APPROVAL;
  limitations: string[];
  report: AuditReport;
};

export interface ReportQuery {
  arena?: string;
  custodyDomain?: string;
  battleId?: number;
  community?: number;
  chainId?: string;
  token?: string;
  referenceToken?: string;
  result?: AuditResult;
  policyVersion?: string;
  policyHash?: string;
  freshness?: Freshness;
  pageSize?: number;
  cursor?: string;
}

export interface QueryPage {
  items: ObservationView[];
  nextCursor: string | null;
  pageSize: number;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export class QueryValidationError extends Error {
  constructor(reason: string) {
    super(`invalid query: ${reason}`);
    this.name = "QueryValidationError";
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RESULTS: readonly AuditResult[] = ["pass", "reject", "pending"];
const FRESHNESS: readonly Freshness[] = ["fresh", "expired", "not_applicable"];

export function freshnessOf(report: AuditReport, now: Date): Freshness {
  // Only a pass can carry an approval window; everything else has no applicable expiry.
  if (report.result !== "pass") return "not_applicable";
  const raw = report.times.expiresAt;
  if (raw === null) return "not_applicable";
  const t = Date.parse(raw);
  // A null or malformed expiry can never imply fresh.
  if (Number.isNaN(t)) return "not_applicable";
  return now.getTime() >= t ? "expired" : "fresh";
}

function limitationsOf(report: AuditReport): string[] {
  const lines = [
    "Historical observation only: not current lock approval, custody proof, transaction execution, or a current-policy check.",
    report.attestation,
    `Liquidity valuation source ${report.liquidity.valuationSource}: ${report.liquidity.valuationNote}`,
  ];
  if (report.auditKind === "reference_token" && report.reference) {
    lines.push(
      `Reference-token audit: evidence describes mainnet reference chain ${report.reference.chainId} token ` +
        `${report.reference.token}; the chain ${report.asset.chainId} mock token ${report.asset.token} was not itself audited.`,
    );
  }
  return lines;
}

export function toView(o: ArchivedObservation, now: Date): ObservationView {
  return {
    observationId: o.observationId,
    seq: o.seq,
    archivedAt: o.archivedAt,
    provenance: o.provenance,
    domain: o.domain,
    attribution: o.attribution,
    historicalResult: o.report.result,
    freshness: freshnessOf(o.report, now),
    currentApproval: CURRENT_APPROVAL,
    limitations: limitationsOf(o.report),
    report: o.report,
  };
}

function normalizeAddress(value: string, field: string): string {
  if (!ADDRESS.test(value)) throw new QueryValidationError(`${field} must be a 20-byte 0x address`);
  return value.toLowerCase();
}

function parseCursor(cursor: string): number {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new QueryValidationError("cursor is not valid");
  }
  const n = Number(decoded);
  if (!Number.isInteger(n) || n < 0) throw new QueryValidationError("cursor is not valid");
  return n;
}

const encodeCursor = (seq: number): string => Buffer.from(String(seq), "utf8").toString("base64url");

/** Validates, normalizes and clamps raw query params. Unknown enum values are rejected, not ignored. */
export function normalizeQuery(raw: ReportQuery): Required<Pick<ReportQuery, "pageSize">> & ReportQuery {
  const q: ReportQuery = {};
  if (raw.arena !== undefined) q.arena = String(raw.arena);
  if (raw.custodyDomain !== undefined) q.custodyDomain = String(raw.custodyDomain);
  if (raw.policyVersion !== undefined) q.policyVersion = String(raw.policyVersion);
  if (raw.chainId !== undefined) {
    if (!/^[0-9]+$/.test(String(raw.chainId))) throw new QueryValidationError("chainId must be numeric");
    q.chainId = String(raw.chainId);
  }
  if (raw.token !== undefined) q.token = normalizeAddress(String(raw.token), "token");
  if (raw.referenceToken !== undefined) q.referenceToken = normalizeAddress(String(raw.referenceToken), "referenceToken");
  if (raw.policyHash !== undefined) {
    const h = String(raw.policyHash).toLowerCase();
    if (!HEX64.test(h)) throw new QueryValidationError("policyHash must be 32-byte hex");
    q.policyHash = h;
  }
  if (raw.result !== undefined) {
    if (!RESULTS.includes(raw.result)) throw new QueryValidationError("result must be pass, reject or pending");
    q.result = raw.result;
  }
  if (raw.freshness !== undefined) {
    if (!FRESHNESS.includes(raw.freshness)) throw new QueryValidationError("freshness is not a known category");
    q.freshness = raw.freshness;
  }
  for (const [k, v] of [["battleId", raw.battleId], ["community", raw.community]] as const) {
    if (v !== undefined) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new QueryValidationError(`${k} must be a non-negative integer`);
      q[k] = n;
    }
  }
  let pageSize = DEFAULT_PAGE_SIZE;
  if (raw.pageSize !== undefined) {
    const n = Number(raw.pageSize);
    if (!Number.isInteger(n) || n < 1) throw new QueryValidationError("pageSize must be a positive integer");
    pageSize = Math.min(n, MAX_PAGE_SIZE);
  }
  if (raw.cursor !== undefined && raw.cursor !== "") {
    parseCursor(raw.cursor); // validate the format here so a bad cursor is a parameter error
    q.cursor = raw.cursor;
  }
  return { ...q, pageSize };
}

function matches(view: ObservationView, q: ReportQuery): boolean {
  const r = view.report;
  if (q.arena !== undefined && view.domain.arena !== q.arena) return false;
  if (q.custodyDomain !== undefined && view.domain.custodyDomain !== q.custodyDomain) return false;
  if (q.battleId !== undefined && view.attribution.battleId !== q.battleId) return false;
  if (q.community !== undefined && view.attribution.community !== q.community) return false;
  if (q.chainId !== undefined && r.asset.chainId !== q.chainId) return false;
  if (q.token !== undefined && r.asset.token.toLowerCase() !== q.token) return false;
  if (q.referenceToken !== undefined && (r.reference?.token.toLowerCase() ?? null) !== q.referenceToken) return false;
  if (q.result !== undefined && r.result !== q.result) return false;
  if (q.policyVersion !== undefined && r.policy.version !== q.policyVersion) return false;
  if (q.policyHash !== undefined && r.policy.hash !== q.policyHash) return false;
  if (q.freshness !== undefined && view.freshness !== q.freshness) return false;
  return true;
}

/**
 * Filters and paginates `observations` (expected in stable `seq` order). Ordering is insertion
 * order ascending: new observations always receive a higher `seq` and so append at the tail,
 * which means a cursor never skips an item and never re-reads one, even with duplicate `decidedAt`
 * timestamps or inserts between pages.
 */
export function queryObservations(observations: ArchivedObservation[], raw: ReportQuery, now: Date): QueryPage {
  const q = normalizeQuery(raw);
  const afterSeq = q.cursor !== undefined ? parseCursor(q.cursor) : 0;
  const items: ObservationView[] = [];
  let nextCursor: string | null = null;
  for (const o of observations) {
    if (o.seq <= afterSeq) continue;
    const view = toView(o, now);
    if (!matches(view, q)) continue;
    if (items.length === q.pageSize) {
      // There is at least one more match beyond this page; stop and expose a cursor.
      nextCursor = encodeCursor(items[items.length - 1]!.seq);
      return { items, nextCursor, pageSize: q.pageSize };
    }
    items.push(view);
  }
  return { items, nextCursor, pageSize: q.pageSize };
}
