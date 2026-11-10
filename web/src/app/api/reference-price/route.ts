import {
  readReferencePrices,
  type ReferencePrices,
} from "@/lib/reference-price/reader";
import { referenceSymbols } from "@/lib/reference-price/pools";

export const dynamic = "force-dynamic";

/** One shared reading per second, so many viewers cost the RPC one request, not one each. */
let cache: { at: number; value: ReferencePrices } | null = null;
let inflight: Promise<ReferencePrices> | null = null;

/**
 * Live reference prices (token in WETH) for the display-only preview chart. The RPC URL is server configuration
 * (`REFERENCE_RPC_URL`), the symbols come only from the fixed table, and the answer is never scoring evidence.
 */
export async function GET(): Promise<Response> {
  const rpcUrl =
    process.env.PRICE_PREVIEW_RPC_URL?.trim() ||
    process.env.REFERENCE_RPC_URL?.trim();
  if (!rpcUrl) {
    return Response.json(
      { ok: false, error: "PRICE_PREVIEW_RPC_URL is not set on the server" },
      { status: 503 },
    );
  }
  const now = Date.now();
  if (cache && now - cache.at < 1_000)
    return Response.json({ ok: true, ...cache.value });
  try {
    inflight ??= readReferencePrices(rpcUrl, referenceSymbols()).finally(() => {
      inflight = null;
    });
    const value = await inflight;
    cache = { at: Date.now(), value };
    return Response.json({ ok: true, ...value });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "reference RPC failed";
    return Response.json(
      { ok: false, error: message.slice(0, 200) },
      { status: 502 },
    );
  }
}
