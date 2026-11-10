import { createServer, type Server } from "node:http";
import { FaucetService } from "./service.js";

export interface FaucetHttpRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
}
export interface FaucetHttpResponse {
  status: number;
  body: string;
}
export interface FaucetHttpDeps {
  faucet: FaucetService;
  /** Resolves a read-session token to its account; throws on a missing, forged or expired token. */
  accountOf: (token: unknown) => string;
}

const MAX_BODY = 2_048;
const reply = (status: number, body: unknown): FaucetHttpResponse => ({ status, body: JSON.stringify(body) });

const bearer = (header: string | undefined): string | null => {
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{1,1024})$/.exec(header ?? "");
  return m ? m[1]! : null;
};

/**
 * `GET /faucet/status` and `POST /faucet/claim {tokens?: string[]}`. The claiming account is always the one the read
 * session is bound to; nothing in the body can name another account.
 */
export async function handleFaucetRequest(req: FaucetHttpRequest, deps: FaucetHttpDeps): Promise<FaucetHttpResponse> {
  let path: string;
  try {
    path = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return reply(400, { error: "malformed request target" });
  }
  if (path !== "/faucet/status" && path !== "/faucet/claim") return reply(404, { error: "not found" });
  const token = bearer(req.authorization);
  let account: string;
  try {
    account = deps.accountOf(token);
  } catch {
    return reply(401, { error: "a valid read session is required" });
  }
  if (path === "/faucet/status") {
    if (req.method !== "GET") return reply(405, { error: "method not allowed" });
    try {
      return reply(200, { account, live: deps.faucet.live, tokens: await deps.faucet.status(account) });
    } catch {
      return reply(503, { error: "faucet status unavailable" });
    }
  }
  if (req.method !== "POST") return reply(405, { error: "method not allowed" });
  if (req.body.length > MAX_BODY) return reply(413, { error: "body too large" });
  let tokens: string[] | undefined;
  if (req.body.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body);
    } catch {
      return reply(400, { error: "body must be JSON" });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return reply(400, { error: "body must be a JSON object" });
    const keys = Object.keys(parsed);
    if (keys.some((k) => k !== "tokens")) return reply(400, { error: "unknown field" });
    const t = (parsed as { tokens?: unknown }).tokens;
    if (t !== undefined) {
      if (!Array.isArray(t) || t.length > 16 || !t.every((s) => typeof s === "string" && /^[A-Za-z0-9]{1,16}$/.test(s))) return reply(400, { error: "tokens must be a short list of symbols" });
      tokens = t as string[];
    }
  }
  try {
    return reply(200, { account, live: deps.faucet.live, results: await deps.faucet.claim(account, tokens) });
  } catch (e) {
    return reply(400, { error: e instanceof Error ? e.message : "claim refused" });
  }
}

export function startFaucetServer(port: number, host: string, deps: FaucetHttpDeps): Server {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY * 2 && !aborted) {
        aborted = true;
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "body too large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      void handleFaucetRequest({ method: req.method, url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") }, deps).then((r) => {
        res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(r.body);
      });
    });
  });
  server.listen(port, host);
  return server;
}
