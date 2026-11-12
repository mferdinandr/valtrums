import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Challenges } from "./auth.js";
import { HostedError, type HostedAgents } from "./manager.js";
import type { SessionStore } from "./sessions.js";

/**
 * HTTP API of the hosted-agent service (OpenSpec `hosted-player-agents`, `hosted-agents-database`). Every route except
 * the sign-in routes needs a session. The session token is an `httpOnly` cookie, so page scripts never read it; an
 * `Authorization: Bearer` header is also accepted for non-browser clients. A session only reaches its own owner's agents.
 */
export interface ServerOptions {
  agents: HostedAgents;
  challenges: Challenges;
  sessions: SessionStore;
  keyBelongsTo: (account: string, publicKey: string) => Promise<boolean>;
  allowedOrigin: string;
  sessionTtlMs?: number;
  /**
   * Cookie attributes. `Secure` is required for `SameSite=None` (web app and service on different sites) and is set
   * by default when the allowed origin is https.
   */
  cookie?: { sameSite?: "Lax" | "None" | "Strict"; secure?: boolean };
}

export const SESSION_COOKIE = "valtrum_hosted_session";
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

const cookieValue = (header: string | undefined, name: string): string | undefined => {
  for (const part of (header ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || undefined;
  }
  return undefined;
};

export function createHostedServer(o: ServerOptions): Server {
  const ttl = o.sessionTtlMs ?? 60 * 60_000;
  const secure = o.cookie?.secure ?? o.allowedOrigin.startsWith("https://");
  const sameSite = o.cookie?.sameSite ?? "Lax";
  if (sameSite === "None" && !secure) throw new Error("SameSite=None needs a Secure cookie (https)");

  const setCookie = (value: string, maxAgeSecs: number): string =>
    `${SESSION_COOKIE}=${value}; HttpOnly; Path=/; Max-Age=${maxAgeSecs}; SameSite=${sameSite}${secure ? "; Secure" : ""}`;

  const send = (res: ServerResponse, status: number, body: unknown, cookie?: string) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": o.allowedOrigin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      vary: "origin",
      ...(cookie ? { "set-cookie": cookie } : {}),
    });
    res.end(JSON.stringify(body));
  };

  const tokenOf = (req: IncomingMessage): string | undefined =>
    cookieValue(req.headers.cookie, SESSION_COOKIE) ?? /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];

  const route = async (req: IncomingMessage): Promise<{ body: unknown; cookie?: string }> => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/healthz") return { body: { ok: true } };

    if (method === "POST" && path === "/auth/challenge") {
      const body = await readJson(req);
      const account = String(body.accountId ?? "");
      if (!ACCOUNT.test(account)) throw new HostedError("bad_account", "accountId must be a NEAR account id");
      return { body: o.challenges.issue(account) };
    }
    if (method === "POST" && path === "/auth/verify") {
      const body = await readJson(req);
      const proof = { account: String(body.accountId ?? ""), publicKey: String(body.publicKey ?? ""), signature: String(body.signature ?? ""), nonce: String(body.nonce ?? "") };
      if (!ACCOUNT.test(proof.account) || !(await o.challenges.redeem(proof, o.keyBelongsTo))) {
        throw new HostedError("unauthorized", "the sign-in proof was not accepted", 401);
      }
      const token = await o.sessions.issue(proof.account, ttl);
      // The token is only in the cookie; the body carries no secret.
      return { body: { owner: proof.account, expiresInMs: ttl }, cookie: setCookie(token, Math.floor(ttl / 1000)) };
    }

    const token = tokenOf(req);
    const owner = await o.sessions.read(token);

    if (method === "POST" && path === "/auth/logout") {
      await o.sessions.revoke(token);
      return { body: { ok: true }, cookie: setCookie("", 0) };
    }
    if (!owner) throw new HostedError("unauthorized", "sign in with your wallet first", 401);
    if (method === "GET" && path === "/auth/session") return { body: { owner } };

    if (path === "/agents" && method === "GET") return { body: { agents: await o.agents.list(owner) } };
    if (path === "/agents" && method === "POST") {
      const body = await readJson(req);
      return { body: await o.agents.create(owner, { style: body.style, sweep: body.sweep, keepWhole: body.keepWhole }) };
    }
    const m = /^\/agents\/([^/]+)(?:\/(start|stop|export))?$/.exec(path);
    if (m) {
      const account = decodeURIComponent(m[1]!);
      const action = m[2];
      if (!action && method === "GET") return { body: await o.agents.get(owner, account) };
      if (action === "start" && method === "POST") return { body: await o.agents.start(owner, account) };
      if (action === "stop" && method === "POST") return { body: await o.agents.stop(owner, account) };
      if (action === "export" && method === "POST") return { body: await o.agents.exportKey(owner, account) };
    }
    throw new HostedError("not_found", "no such route", 404);
  };

  return createServer((req, res) => {
    if (req.method === "OPTIONS") return send(res, 204, {});
    route(req).then(
      ({ body, cookie }) => send(res, 200, body, cookie),
      (e: unknown) => {
        if (e instanceof HostedError) return send(res, e.status, { error: e.code, message: e.message });
        console.error(JSON.stringify({ event: "hosted_server_error", message: e instanceof Error ? e.message : String(e) }));
        send(res, 500, { error: "internal", message: "something went wrong" });
      },
    );
  });
}
