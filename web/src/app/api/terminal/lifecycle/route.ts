import { NextResponse } from "next/server";
import { handleLifecycleParse } from "@/lib/terminal/lifecycle-parse-route";

export const dynamic = "force-dynamic";

/** Parses a prompt into a validated lifecycle intent. It never signs, never proxies an action and holds no account state. */
export async function POST(req: Request): Promise<NextResponse> {
  const { status, body } = await handleLifecycleParse(req, { env: process.env });
  return NextResponse.json(body, { status });
}
