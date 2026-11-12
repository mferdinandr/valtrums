export const dynamic = "force-dynamic";

/**
 * Same-origin NEAR RPC proxy for the browser. A key in a NEXT_PUBLIC_* variable or URL would ship to every visitor,
 * so the FastNEAR key stays on the server (`FASTNEAR_API_KEY`, never NEXT_PUBLIC_) and is sent as
 * `Authorization: Bearer <key>`. Only read and receipt-status JSON-RPC methods are forwarded, so this cannot be
 * used as a general relay. Set `NEXT_PUBLIC_NEAR_RPC_URL=/api/near-rpc` to use it.
 */
const ALLOWED_METHODS = new Set([
  "query",
  "block",
  "chunk",
  "status",
  "gas_price",
  "tx",
  "EXPERIMENTAL_tx_status",
  "EXPERIMENTAL_receipt",
  "validators",
]);
const MAX_BODY_BYTES = 64 * 1024;

function upstreamUrl(): string {
  const configured = process.env.NEAR_RPC_UPSTREAM_URL?.trim();
  if (configured) return configured;
  return process.env.NEXT_PUBLIC_NEAR_NETWORK === "mainnet"
    ? "https://rpc.mainnet.fastnear.com"
    : "https://test.rpc.fastnear.com";
}

function rpcError(status: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message } }, { status });
}

export async function POST(req: Request): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return rpcError(413, "request too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rpcError(400, "invalid JSON");
  }
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > 20) return rpcError(400, "invalid batch");
  for (const c of calls) {
    const method = (c as { method?: unknown } | null)?.method;
    if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) {
      return rpcError(403, `method not allowed: ${String(method).slice(0, 64)}`);
    }
  }
  const key = process.env.FASTNEAR_API_KEY?.trim();
  const upstream = await fetch(upstreamUrl(), {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: text,
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!upstream) return rpcError(502, "upstream RPC unreachable");
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
