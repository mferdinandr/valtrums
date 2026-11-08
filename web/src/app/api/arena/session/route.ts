import { NextResponse } from "next/server";
import { proxyOpenSession } from "@/lib/arena-read/proxy";

export const dynamic = "force-dynamic";

/** Exchanges a NEP-413 signature for a read-only session. Grants no signing or spending authority. */
export async function POST(req: Request): Promise<NextResponse> {
  const out = await proxyOpenSession(await req.text(), process.env);
  return NextResponse.json(out.body, { status: out.status, headers: { "cache-control": "no-store" } });
}
