import { NextResponse } from "next/server";
import { proxyApplicationRead } from "@/lib/arena-read/proxy";

export const dynamic = "force-dynamic";
export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const out = await proxyApplicationRead(path.join("/"), new URL(req.url).searchParams, process.env, undefined, req.signal);
  return NextResponse.json(out.body, { status: out.status, headers: { "cache-control": "no-store" } });
}
