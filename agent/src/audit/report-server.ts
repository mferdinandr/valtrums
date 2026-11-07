import { type Server, createServer } from "node:http";
import { ArchiveCorruptError, type ReportArchive } from "./report-archive.js";
import { QueryValidationError, type ReportQuery, queryObservations, toView } from "./report-query.js";
import { formatAuditReport } from "./report.js";

/**
 * Passive, read-only HTTP surface over the audit report archive, following the health server's
 * dependency-free conventions. It reads the archive and nothing else: it never launches the agent,
 * holds a signing key, calls a provider, reads RPC, or mutates a report. There is no upload, import,
 * POST or DELETE route — data enters only through the internal typed sink. Responses are JSON or
 * plain text, never raw provider HTML or executable markup, and always carry `no-store`.
 */

export interface ReportResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface ReportServerDeps {
  archive: ReportArchive;
  /** Injected trusted clock; freshness is computed from it, never from the request. */
  now: () => Date;
}

const JSON_TYPE = "application/json";
const TEXT_TYPE = "text/plain; charset=utf-8";
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_URL_LENGTH = 2048;
const MAX_QUERY_PARAMS = 32;

const json = (status: number, body: unknown): ReportResponse => ({
  status,
  contentType: JSON_TYPE,
  body: JSON.stringify(body),
});

const errorBody = (status: number, error: string): ReportResponse => json(status, { error });

function queryFromParams(params: URLSearchParams): ReportQuery {
  const q: ReportQuery = {};
  const str = (k: keyof ReportQuery) => {
    const v = params.get(k);
    if (v !== null) (q as Record<string, unknown>)[k] = v;
  };
  for (const k of ["arena", "network", "chainId", "token", "referenceToken", "policyVersion", "policyHash", "cursor"] as const) {
    str(k);
  }
  const result = params.get("result");
  if (result !== null) q.result = result as ReportQuery["result"];
  const freshness = params.get("freshness");
  if (freshness !== null) q.freshness = freshness as ReportQuery["freshness"];
  for (const k of ["battleId", "community", "pageSize"] as const) {
    const v = params.get(k);
    if (v !== null) (q as Record<string, unknown>)[k] = v;
  }
  return q;
}

export async function handleReportRequest(
  method: string | undefined,
  rawUrl: string,
  deps: ReportServerDeps,
): Promise<ReportResponse> {
  if (method !== "GET" && method !== "HEAD") return errorBody(405, "method not allowed");
  if (rawUrl.length > MAX_URL_LENGTH) return errorBody(400, "request target too long");

  let url: URL;
  try {
    url = new URL(rawUrl, "http://localhost");
  } catch {
    return errorBody(400, "malformed request target");
  }
  if ([...url.searchParams.keys()].length > MAX_QUERY_PARAMS) return errorBody(400, "too many query parameters");

  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments[0] !== "audit-reports") return errorBody(404, "not found");

  // Load once per request; an unreadable archive is degraded service, never a fabricated empty success.
  let observations;
  try {
    observations = await deps.archive.snapshot();
  } catch (err) {
    if (err instanceof ArchiveCorruptError) return errorBody(503, "archive is unavailable");
    return errorBody(503, "archive is unavailable");
  }
  const now = deps.now();

  // GET /audit-reports — filtered, paginated list.
  if (segments.length === 1) {
    try {
      const page = queryObservations(observations, queryFromParams(url.searchParams), now);
      return json(200, { items: page.items, nextCursor: page.nextCursor, pageSize: page.pageSize });
    } catch (err) {
      if (err instanceof QueryValidationError) return errorBody(400, err.message);
      throw err;
    }
  }

  // /audit-reports/:evidenceHash[/text]
  let evidenceHash: string;
  try {
    evidenceHash = decodeURIComponent(segments[1] ?? "");
  } catch {
    return errorBody(400, "malformed evidence hash");
  }
  // The strict hex form also blocks path traversal (no slashes, dots or separators can match).
  if (!HEX64.test(evidenceHash)) return errorBody(400, "evidence hash must be 32-byte lowercase hex");

  const forEvidence = observations.filter((o) => o.report.evidenceHash === evidenceHash);

  if (segments.length === 2) {
    if (forEvidence.length === 0) return errorBody(404, "no observations for this evidence");
    try {
      const page = queryObservations(forEvidence, queryFromParams(url.searchParams), now);
      return json(200, {
        evidenceHash,
        observations: page.items,
        nextCursor: page.nextCursor,
        pageSize: page.pageSize,
      });
    } catch (err) {
      if (err instanceof QueryValidationError) return errorBody(400, err.message);
      throw err;
    }
  }

  if (segments.length === 3 && segments[2] === "text") {
    if (forEvidence.length === 0) return errorBody(404, "no observations for this evidence");
    const wanted = url.searchParams.get("observation");
    const chosen = wanted
      ? forEvidence.find((o) => o.observationId === wanted)
      : [...forEvidence].sort((a, b) => b.seq - a.seq)[0];
    if (!chosen) return errorBody(404, "observation not found");
    // Reuse the single report formatter; no second formatting policy is introduced here.
    return { status: 200, contentType: TEXT_TYPE, body: formatAuditReport(chosen.report) };
  }

  return errorBody(404, "not found");
}

/** Dependency-free HTTP server bound to loopback by default. Returns undefined when port is 0. */
export function startReportServer(
  port: number,
  deps: ReportServerDeps,
  host = "127.0.0.1",
): Promise<Server | undefined> {
  if (port === 0) return Promise.resolve(undefined);
  const server = createServer((req, res) => {
    void handleReportRequest(req.method, req.url ?? "/", deps)
      .then((out) => {
        res.writeHead(out.status, { "content-type": out.contentType, "cache-control": "no-store" });
        res.end(req.method === "HEAD" ? undefined : out.body);
      })
      .catch(() => {
        res.writeHead(500, { "content-type": JSON_TYPE, "cache-control": "no-store" });
        res.end(req.method === "HEAD" ? undefined : JSON.stringify({ error: "internal error" }));
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

export function parseReportPort(env: Record<string, string | undefined>): number {
  const raw = env.AUDIT_REPORT_PORT?.trim();
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error("AUDIT_REPORT_PORT must be an integer between 0 and 65535");
  }
  return n;
}
