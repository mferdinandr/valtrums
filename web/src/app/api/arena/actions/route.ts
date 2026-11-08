import { NextResponse } from "next/server";
import { proxyAction } from "@/lib/arena-read/proxy";

export const dynamic = "force-dynamic";

/** Creates a canonical action preview; nothing is signed or sent here. */
export async function POST(req: Request): Promise<NextResponse> {
  const out = await proxyAction({ method: "POST" }, await req.text(), req.headers.get("authorization"), process.env);
  return NextResponse.json(out.body, { status: out.status, headers: { "cache-control": "no-store" } });
}
