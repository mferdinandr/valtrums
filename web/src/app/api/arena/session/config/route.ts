import { NextResponse } from "next/server";
import { proxySessionConfig } from "@/lib/arena-read/proxy";

export const dynamic = "force-dynamic";

/** Public, non-secret signing parameters from the read service. Grants nothing. */
export async function GET(req: Request): Promise<NextResponse> {
  const out = await proxySessionConfig(process.env, undefined, req.signal);
  return NextResponse.json(out.body, { status: out.status, headers: { "cache-control": "no-store" } });
}
