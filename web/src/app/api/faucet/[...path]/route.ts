import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The faucet service. Server-side only: the browser never learns this address. */
const upstream = () => (process.env.FAUCET_API_URL?.trim() || "http://127.0.0.1:8792").replace(/\/+$/, "");
const ALLOWED = new Set(["status", "claim"]);

async function forward(req: Request, ctx: { params: Promise<{ path: string[] }> }, method: "GET" | "POST"): Promise<NextResponse> {
  const { path } = await ctx.params;
  if (path.length !== 1 || !ALLOWED.has(path[0]!)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const auth = req.headers.get("authorization");
  try {
    const res = await fetch(`${upstream()}/faucet/${path[0]}`, {
      method,
      headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" },
      ...(method === "POST" ? { body: (await req.text()).slice(0, 4_096) } : {}),
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    const text = await res.text();
    return new NextResponse(text, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "the faucet is unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

export const GET = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => forward(req, ctx, "GET");
export const POST = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => forward(req, ctx, "POST");
