import { logoUpstream } from "@/lib/token-logos";

export const dynamic = "force-dynamic";

const MAX_BYTES = 300_000;

/**
 * Serves a token logo from the fixed table in `lib/token-logos.ts`. The upstream URL is built only from a known
 * symbol, never from the request, so this cannot be pointed at another host. A missing or failing image is a
 * plain 404 and the page shows a monogram instead.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ symbol: string }> }): Promise<Response> {
  const { symbol } = await ctx.params;
  const upstream = logoUpstream(symbol);
  if (!upstream) return new Response(null, { status: 404 });
  try {
    const res = await fetch(upstream, { signal: AbortSignal.timeout(8_000), next: { revalidate: 86_400 } });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/^image\/(png|webp|jpeg|gif|avif)/.test(type)) return new Response(null, { status: 404 });
    const body = await res.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return new Response(null, { status: 404 });
    return new Response(body, {
      headers: {
        "content-type": type,
        "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
        "x-content-type-options": "nosniff",
        "x-logo-source": "dexscreener-listing; not verification",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
