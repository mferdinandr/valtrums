import { NextResponse } from "next/server";
import { proxyAction } from "@/lib/arena-read/proxy";

export const dynamic = "force-dynamic";

/** authorize | prepare | broadcast for one action. The wallet, not this route, signs. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; step: string }> }): Promise<NextResponse> {
  const { id, step } = await ctx.params;
  const out = await proxyAction({ method: "POST", id, step }, await req.text(), req.headers.get("authorization"), process.env);
  return NextResponse.json(out.body, { status: out.status, headers: { "cache-control": "no-store" } });
}
