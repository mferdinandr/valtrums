import { NextResponse } from "next/server";
import { handleLifecycleParse } from "@/lib/terminal/lifecycle-parse-route";
import { TerminalGuard, clientKeyOf, terminalLimitsFromEnv } from "@/lib/terminal/rate-limit";

export const dynamic = "force-dynamic";

// One guard per server instance: its counters live as long as the instance does.
let guard: TerminalGuard | null = null;

/**
 * Parses a prompt into a validated lifecycle intent. It never signs, never proxies an action and holds no account
 * state. Model use is bounded per client and in total (see rate-limit.ts); over a limit the built-in rules answer.
 */
export async function POST(req: Request): Promise<NextResponse> {
  guard ??= new TerminalGuard(terminalLimitsFromEnv(process.env));
  const { status, body } = await handleLifecycleParse(req, { env: process.env, guard, client: clientKeyOf(req.headers) });
  return NextResponse.json(body, { status, headers: status === 429 ? { "retry-after": "60" } : {} });
}
