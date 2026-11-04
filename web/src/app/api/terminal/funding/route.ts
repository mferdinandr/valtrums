import { NextResponse } from "next/server";
import { SUPPORTED_CHAINS } from "@/lib/terminal/intent";
import { ONECLICK_DEFAULT_URL, createOneClickService } from "@/lib/terminal/oneclick";

export const dynamic = "force-dynamic";

const NEAR_ACCOUNT_RE = /^[a-z0-9._-]{2,64}$/;
const ADDRESS_RE = /^[A-Za-z0-9._:-]{6,120}$/;
const AMOUNT_RE = /^\d{1,15}$/;

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** Thin, validated proxy to the 1Click API so the optional JWT stays on the server. */
export async function POST(req: Request): Promise<NextResponse> {
  if (process.env.NEXT_PUBLIC_FUNDING_ROUTER !== "intents") return bad("Cross-chain funding is not enabled", 404);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("Invalid request");
  }
  const service = createOneClickService({
    baseUrl: process.env.ONECLICK_API_URL?.trim() || ONECLICK_DEFAULT_URL,
    apiKey: process.env.ONECLICK_API_KEY?.trim() || undefined,
  });

  try {
    if (body.action === "status") {
      if (typeof body.depositAddress !== "string" || !ADDRESS_RE.test(body.depositAddress)) return bad("Invalid deposit address");
      return NextResponse.json(await service.status(body.depositAddress));
    }
    if (body.action !== "quote" && body.action !== "commit") return bad("Unknown action");
    const { chain, amount, recipient, refundTo, slippageBps } = body;
    if (typeof chain !== "string" || !(SUPPORTED_CHAINS as readonly string[]).includes(chain)) return bad("Unsupported chain");
    if (typeof amount !== "string" || !AMOUNT_RE.test(amount) || BigInt(amount) <= 0n) return bad("Invalid amount");
    if (typeof recipient !== "string" || !NEAR_ACCOUNT_RE.test(recipient)) return bad("Invalid recipient");
    if (typeof refundTo !== "string" || !ADDRESS_RE.test(refundTo)) return bad("A valid refund address on the origin chain is required");
    if (typeof slippageBps !== "number" || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 500) return bad("Invalid slippage");
    const out = await service.quote({ chain, amount, recipient, refundTo, slippageBps }, body.action === "commit");
    return NextResponse.json(out);
  } catch (e) {
    return bad(e instanceof Error ? e.message : "Funding request failed", 502);
  }
}
