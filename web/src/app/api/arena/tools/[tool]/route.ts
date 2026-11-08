import { NextResponse } from "next/server";
import { proxyReadTool } from "@/lib/arena-read/proxy";

export const dynamic = "force-dynamic";

/** Read-only: only GET is exported, so no write method reaches the read API through this route. */
export async function GET(req: Request, ctx: { params: Promise<{ tool: string }> }): Promise<NextResponse> {
  const { tool } = await ctx.params;
  const url = new URL(req.url);
  const out = await proxyReadTool(tool, url.searchParams, req.headers.get("authorization"), process.env);
  return NextResponse.json(out.body, { status: out.status, headers: { "cache-control": "no-store" } });
}
