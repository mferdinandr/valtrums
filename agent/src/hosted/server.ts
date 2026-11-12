import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Challenges } from "./auth.js";
import { issueSession, readSession } from "./crypto.js";
import { HostedError, type HostedAgents } from "./manager.js";

/**
 * HTTP API of the hosted-agent service (OpenSpec `hosted-player-agents`). Every route except the two sign-in routes
 * needs a session token from `POST /auth/verify`, and a session only reaches the agents of its own owner account.
 */
export interface ServerOptions {
  agents: HostedAgents;
  challenges: Challenges;
  kek: Buffer;
  keyBelongsTo: (account: string, publicKey: string) => Promise<boolean>;
  allowedOrigin: string;
  now?: () => number;
  sessionTtlMs?: number;
}

const MAX_BODY = 8 * 1024;
const ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HostedError("too_large", "request body is too large", 413);
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HostedError("bad_json", "body must be a JSON object");
  }
}

export function createHostedServer(o: ServerOptions): Server {
  const now = o.now ?? Date.now;
  const ttl = o.sessionTtlMs ?? 60 * 60_000;

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": o.allowedOrigin,
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      vary: "origin",
    });
    res.end(JSON.stringify(body));
  };

  const route = async (req: IncomingMessage): Promise<unknown> => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/healthz") return { ok: true };

    if (method === "POST" && path === "/auth/challenge") {
      const body = await readJson(req);
      const account = String(body.accountId ?? "");
      if (!ACCOUNT.test(account)) throw new HostedError("bad_account", "accountId must be a NEAR account id");
      return o.challenges.issue(account);
    }
    if (method === "POST" && path === "/auth/verify") {
      const body = await readJson(req);
      const proof = { account: String(body.accountId ?? ""), publicKey: String(body.publicKey ?? ""), signature: String(body.signature ?? ""), nonce: String(body.nonce ?? "") };
      if (!ACCOUNT.test(proof.account) || !(await o.challenges.redeem(proof, o.keyBelongsTo))) {
        throw new HostedError("unauthorized", "the sign-in proof was not accepted", 401);
      }
      return { token: issueSession(o.kek, proof.account, now(), ttl), expiresInMs: ttl };
    }

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const owner = readSession(o.kek, bearer, now());
    if (!owner) throw new HostedError("unauthorized", "sign in with your wallet first", 401);

    if (path === "/agents" && method === "GET") return { agents: o.agents.list(owner) };
    if (path === "/agents" && method === "POST") {
      const body = await readJson(req);
      return o.agents.create(owner, { style: body.style, sweep: body.sweep, keepWhole: body.keepWhole });
    }
    const m = /^\/agents\/([^/]+)(?:\/(start|stop|export))?$/.exec(path);
    if (m) {
      const account = decodeURIComponent(m[1]!);
      const action = m[2];
      if (!action && method === "GET") return o.agents.get(owner, account);
      if (action === "start" && method === "POST") return o.agents.start(owner, account);
      if (action === "stop" && method === "POST") return o.agents.stop(owner, account);
      if (action === "export" && method === "POST") return o.agents.exportKey(owner, account);
    }
    throw new HostedError("not_found", "no such route", 404);
  };

  return createServer((req, res) => {
    if (req.method === "OPTIONS") return send(res, 204, {});
    route(req).then(
      (body) => send(res, 200, body),
      (e: unknown) => {
        if (e instanceof HostedError) return send(res, e.status, { error: e.code, message: e.message });
        console.error(JSON.stringify({ event: "hosted_server_error", message: e instanceof Error ? e.message : String(e) }));
        send(res, 500, { error: "internal", message: "something went wrong" });
      },
    );
  });
}
