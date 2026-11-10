import { READ_TOOLS } from "./client";

/**
 * Server-side forwarding to the agent read API (`ARENA_READ_API_URL`, server-only env). Only the
 * known read tools and `POST /session` are forwarded; the read session travels in the
 * Authorization header and is never added to the URL.
 */

export const MAX_SESSION_BODY = 8 * 1024;

export interface ProxyResult {
  status: number;
  body: unknown;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function baseUrl(env: Record<string, string | undefined>): string | null {
  const raw = env.ARENA_READ_API_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

async function forward(url: string, init: RequestInit, doFetch: FetchLike, signal?: AbortSignal): Promise<ProxyResult> {
  try {
    const timeout = AbortSignal.timeout(10_000);
    const res = await doFetch(url, { ...init, cache: "no-store", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const body = await res.json().catch(() => ({ error: "read API returned an invalid response" }));
    return { status: res.status, body };
  } catch {
    return { status: 503, body: { error: "read API unavailable" } };
  }
}

/** Versioned public reads only. Private sessions/actions retain their existing gateway. */
export async function proxyApplicationRead(
  path: string, search: URLSearchParams, env: Record<string, string | undefined>,
  doFetch: FetchLike = (u, i) => fetch(u, i), signal?: AbortSignal,
): Promise<ProxyResult> {
  const fail = (status: number, code: string, message: string): ProxyResult => ({ status,
    body: { schemaVersion: "arena-application-v1", error: { code, message, retryable: status === 503 } } });
  if (!/^(capabilities|health|assets|battles|battles\/[1-9][0-9]{0,19}(?:\/audits)?)$/.test(path)) return fail(404, "not_found", "unknown application read route");
  const keys = new Set<string>();
  const allowed = path === "capabilities" ? [] : ["deployment", "protocol", ...(path === "battles" ? ["q", "mode", "status", "community", "limit", "cursor"]
    : path === "assets" ? ["q", "limit", "cursor"] : path.endsWith("/audits") ? ["community", "limit", "cursor"] : [])];
  for (const [k, v] of search) {
    if (keys.has(k) || !allowed.includes(k) || v.length > 1024) return fail(400, "invalid_query", "invalid query parameters");
    keys.add(k);
  }
  if (path !== "capabilities" && (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(search.get("deployment") ?? "") ||
    !["legacy-v1", "lifecycle-v2"].includes(search.get("protocol") ?? ""))) return fail(400, "invalid_query", "deployment/protocol required");
  if (search.has("limit") && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(search.get("limit")!)) return fail(400, "invalid_query", "limit must be 1 to 50");
  if ((search.get("q") ?? "").trim().length > 64) return fail(400, "invalid_query", "query too long");
  if (search.has("mode") && !["PriceGain", "MarketCapGrowth", "VolumeRatio", "LowestDrawdown"].includes(search.get("mode")!)) return fail(400, "invalid_query", "unknown scoring mode");
  if (search.has("status") && !["open", "locked", "decided"].includes(search.get("status")!)) return fail(400, "invalid_query", "unknown battle status");
  if (search.has("cursor") && !/^[A-Za-z0-9_-]{1,1024}$/.test(search.get("cursor")!)) return fail(400, "invalid_query", "malformed cursor");
  if (search.has("community") && !(path.endsWith("/audits") ? /^(0|[1-9][0-9]{0,2})$/.test(search.get("community")!) && Number(search.get("community")) <= 255 : /^[a-z0-9._-]{2,64}$/.test(search.get("community")!))) return fail(400, "invalid_query", "invalid community");
  const base = baseUrl(env);
  if (!base) return fail(503, "upstream_unavailable", "read API is not configured");
  const out = await forward(`${base}/api/arena/v1/${path}${search.size ? `?${search}` : ""}`, { method: "GET" }, doFetch, signal);
  if ((out.body as { schemaVersion?: string })?.schemaVersion !== "arena-application-v1") return fail(503, "upstream_unavailable", "application read API unavailable");
  return out;
}

export async function proxyReadTool(
  tool: string,
  search: URLSearchParams,
  authorization: string | null,
  env: Record<string, string | undefined>,
  doFetch: FetchLike = (u, i) => fetch(u, i),
): Promise<ProxyResult> {
  if (!(READ_TOOLS as readonly string[]).includes(tool)) return { status: 404, body: { error: "unknown read tool" } };
  if (search.has("session")) return { status: 400, body: { error: "send the read session in the Authorization header" } };
  const base = baseUrl(env);
  if (!base) return { status: 503, body: { error: "read API is not configured" } };
  const headers: Record<string, string> = {};
  if (authorization && /^Bearer [A-Za-z0-9._-]{1,1024}$/.test(authorization)) headers.authorization = authorization;
  const query = search.toString();
  return forward(`${base}/tools/${tool}${query ? `?${query}` : ""}`, { method: "GET", headers }, doFetch);
}

export const ACTION_STEPS = ["authorize", "prepare", "broadcast"] as const;
export type ActionStep = (typeof ACTION_STEPS)[number];
const ACTION_ID = /^act_[0-9a-f]{32}$/;

/**
 * Forwards the action boundary (`/actions`, `/actions/:id`, `/actions/:id/:step`) to the agent
 * action API. Only those paths are reachable; the server never signs or sends: the user's wallet
 * signs the transaction returned by `prepare`.
 */
export async function proxyAction(
  target: { method: "GET" | "POST"; id?: string; step?: string },
  body: string,
  authorization: string | null,
  env: Record<string, string | undefined>,
  doFetch: FetchLike = (u, i) => fetch(u, i),
): Promise<ProxyResult> {
  if (body.length > MAX_SESSION_BODY) return { status: 413, body: { error: "body too large" } };
  if (target.id !== undefined && !ACTION_ID.test(target.id)) return { status: 404, body: { error: "unknown action" } };
  if (target.step !== undefined && !(ACTION_STEPS as readonly string[]).includes(target.step)) {
    return { status: 404, body: { error: "unknown action step" } };
  }
  const valid =
    (target.method === "POST" && target.id === undefined && target.step === undefined) ||
    (target.method === "GET" && target.id !== undefined && target.step === undefined) ||
    (target.method === "POST" && target.id !== undefined && target.step !== undefined);
  if (!valid) return { status: 405, body: { error: "method not allowed" } };
  const base = baseUrl(env);
  if (!base) return { status: 503, body: { error: "read API is not configured" } };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization && /^Bearer [A-Za-z0-9._-]{1,1024}$/.test(authorization)) headers.authorization = authorization;
  const path = ["actions", target.id, target.step].filter(Boolean).join("/");
  return forward(`${base}/${path}`, target.method === "GET" ? { method: "GET", headers } : { method: "POST", headers, body }, doFetch);
}

export async function proxyOpenSession(
  body: string,
  env: Record<string, string | undefined>,
  doFetch: FetchLike = (u, i) => fetch(u, i),
): Promise<ProxyResult> {
  if (body.length > MAX_SESSION_BODY) return { status: 413, body: { error: "body too large" } };
  const base = baseUrl(env);
  if (!base) return { status: 503, body: { error: "read API is not configured" } };
  return forward(`${base}/session`, { method: "POST", headers: { "content-type": "application/json" }, body }, doFetch);
}
