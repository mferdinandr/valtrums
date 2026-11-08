import { type Server, createServer } from "node:http";
import { type ActionToolDeps, callActionTool } from "./actions/tools.js";
import { SessionError, type ReadSessions } from "./session.js";
import { AccessDeniedError, READ_TOOLS, ToolInputError, callReadTool } from "./tools.js";

/**
 * HTTP surface for the web terminal. `GET /tools/:name` runs a read tool, `POST /session`
 * exchanges a NEP-413 signature for a read session, and `/actions` exposes the action boundary
 * (preview, authorize, prepare, broadcast, status). No route signs, sends or reserves anything:
 * the user's wallet signs the prepared transaction. The session token travels only in the
 * Authorization header, never in the URL, so it does not end up in access logs. Every response
 * is JSON with `no-store`.
 */

export interface ReadHttpRequest {
  method: string | undefined;
  url: string;
  authorization?: string | undefined;
  body?: string;
}

export interface ReadHttpResponse {
  status: number;
  body: string;
}

export interface ReadHttpDeps extends ActionToolDeps {
  sessions: ReadSessions;
}

const MAX_URL_LENGTH = 2048;
export const MAX_BODY_BYTES = 8 * 1024;
const NUMERIC_ARGS = new Set(["battleId", "community", "limit"]);

const reply = (status: number, body: unknown): ReadHttpResponse => ({ status, body: JSON.stringify(body) });

function argsFromQuery(params: URLSearchParams): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [k, v] of params) {
    if (k === "session") throw new ToolInputError("send the read session in the Authorization header, not the URL");
    if (k in args) throw new ToolInputError(`duplicate parameter: ${k}`);
    if (k === "battleIds") args[k] = v === "" ? [] : v.split(",").map((x) => Number(x));
    else if (NUMERIC_ARGS.has(k)) args[k] = Number(v);
    else args[k] = v;
  }
  return args;
}

function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer ([A-Za-z0-9._-]{1,1024})$/.exec(header ?? "");
  return m?.[1];
}

export async function handleReadRequest(req: ReadHttpRequest, deps: ReadHttpDeps): Promise<ReadHttpResponse> {
  if (req.url.length > MAX_URL_LENGTH) return reply(400, { error: "request target too long" });
  let url: URL;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return reply(400, { error: "malformed request target" });
  }
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments.length === 1 && segments[0] === "session") {
    if (req.method !== "POST") return reply(405, { error: "method not allowed" });
    let signed: unknown;
    try {
      signed = JSON.parse(req.body ?? "");
    } catch {
      return reply(400, { error: "body must be JSON" });
    }
    try {
      return reply(200, await deps.sessions.open(signed as Parameters<ReadSessions["open"]>[0]));
    } catch (err) {
      if (err instanceof SessionError) return reply(401, { error: err.message });
      return reply(503, { error: "session verification unavailable" });
    }
  }

  if (segments[0] === "actions") return handleActionRequest(req, segments, deps);

  if (segments[0] !== "tools" || segments.length > 2) return reply(404, { error: "not found" });
  if (req.method !== "GET") return reply(405, { error: "method not allowed" });
  if (segments.length === 1) {
    return reply(200, {
      tools: READ_TOOLS.map((t) => ({ name: t.name, description: t.description, accountScoped: t.accountScoped })),
    });
  }

  const name = segments[1] ?? "";
  try {
    const args = argsFromQuery(url.searchParams);
    const tool = READ_TOOLS.find((t) => t.name === name);
    if (tool?.accountScoped) {
      const token = bearer(req.authorization);
      if (token) args.session = token;
    }
    return reply(200, await callReadTool(name, args, deps));
  } catch (err) {
    if (err instanceof ToolInputError) return reply(400, { error: err.message });
    if (err instanceof AccessDeniedError) return reply(403, { error: err.message });
    return reply(503, { error: "read source unavailable" });
  }
}

/**
 * Action routes (same boundary as the MCP action tools):
 *   POST /actions                  {request}  -> preview_action
 *   POST /actions/:id/authorize    {proof}    -> authorize_action
 *   POST /actions/:id/prepare                 -> prepare_action (unsigned transaction)
 *   POST /actions/:id/broadcast    {txHash}   -> report_broadcast
 *   GET  /actions/:id                         -> action_status (checks the receipt)
 * The read session travels only in the Authorization header.
 */
async function handleActionRequest(req: ReadHttpRequest, segments: string[], deps: ReadHttpDeps): Promise<ReadHttpResponse> {
  const token = bearer(req.authorization);
  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try {
      const parsed: unknown = JSON.parse(req.body || "{}");
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return reply(400, { error: "body must be a JSON object" });
      body = parsed as Record<string, unknown>;
    } catch {
      return reply(400, { error: "body must be JSON" });
    }
  }
  const route = (): [string, Record<string, unknown>] | null => {
    if (segments.length === 1 && req.method === "POST") return ["preview_action", { request: body.request }];
    const id = segments[1];
    if (segments.length === 2 && req.method === "GET") return ["action_status", { actionId: id }];
    if (segments.length === 3 && req.method === "POST") {
      if (segments[2] === "authorize") return ["authorize_action", { actionId: id, proof: body.proof }];
      if (segments[2] === "prepare") return ["prepare_action", { actionId: id }];
      if (segments[2] === "broadcast") return ["report_broadcast", { actionId: id, txHash: body.txHash }];
    }
    return null;
  };
  const target = route();
  if (!target) return reply(404, { error: "not found" });
  const [name, args] = target;
  try {
    return reply(200, await callActionTool(name, { ...args, ...(token ? { session: token } : {}) }, deps));
  } catch (err) {
    if (err instanceof ToolInputError) return reply(400, { error: err.message });
    if (err instanceof AccessDeniedError) return reply(403, { error: err.message });
    return reply(503, { error: "action service unavailable" });
  }
}

export function startReadServer(port: number, host: string, deps: ReadHttpDeps): Server {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES && !aborted) {
        aborted = true;
        res.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "body too large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      void handleReadRequest(
        { method: req.method, url: req.url ?? "/", authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") },
        deps,
      ).then((out) => {
        res.writeHead(out.status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(out.body);
      });
    });
  });
  server.listen(port, host);
  return server;
}
