import { NextResponse } from "next/server";
import { proxyAction } from "@/lib/arena-read/proxy";

export const dynamic = "force-dynamic";

/** Durable action status; a broadcast action is checked against its verified receipt. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await ctx.params;
  const out = await proxyAction({ method: "GET", id }, "", req.headers.get("authorization"), process.env);
  return NextResponse.json(out.body, { status: out.status, headers: { "cache-control": "no-store" } });
}
