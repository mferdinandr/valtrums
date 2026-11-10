import { tokenPriceInWeth } from "./math";
import { WETH_ADDRESS, referencePool } from "./pools";

const SEL_TOKEN0 = "0x0dfe1681";
const SEL_TOKEN1 = "0xd21220a7";
const SEL_DECIMALS = "0x313ce567";
const SEL_SLOT0 = "0x3850c7bd";

type Fetch = typeof fetch;
type Meta = { token0IsWeth: boolean; decimals0: number; decimals1: number };

/** Immutable per pool (token order and decimals never change), so it is read once and kept. */
const META = new Map<string, Meta>();

type RpcItem = { id: number; result?: string; error?: unknown };

/** One JSON-RPC batch. Every read goes through here so the RPC sees one request at a time, never one per pool. */
async function batch(
  rpcUrl: string,
  calls: { to: string; data: string }[],
  fetchImpl: Fetch,
): Promise<string[]> {
  const body = calls.map((c, id) => ({
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [{ to: c.to, data: c.data }, "latest"],
  }));
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`RPC answered HTTP ${res.status}`);
  const items = (await res.json()) as RpcItem[] | RpcItem;
  const list = Array.isArray(items) ? items : [items];
  const out: string[] = new Array(calls.length).fill("");
  for (const item of list) {
    if (typeof item.id === "number" && typeof item.result === "string")
      out[item.id] = item.result;
  }
  return out;
}

const word = (hex: string, index: number) =>
  hex.slice(2 + index * 64, 2 + (index + 1) * 64);
const addressOf = (hex: string) =>
  hex.length >= 66 ? `0x${word(hex, 0).slice(24)}`.toLowerCase() : "";

/** Reads the metadata of every pool that is not cached yet, in two batches in total (tokens, then decimals). */
async function loadMetas(
  rpcUrl: string,
  pools: string[],
  fetchImpl: Fetch,
): Promise<void> {
  const missing = pools.filter((p) => !META.has(p));
  if (!missing.length) return;
  const tokens = await batch(
    rpcUrl,
    missing.flatMap((pool) => [
      { to: pool, data: SEL_TOKEN0 },
      { to: pool, data: SEL_TOKEN1 },
    ]),
    fetchImpl,
  );
  const weth = WETH_ADDRESS.toLowerCase();
  const usable = missing.flatMap((pool, i) => {
    const a0 = addressOf(tokens[i * 2] ?? "");
    const a1 = addressOf(tokens[i * 2 + 1] ?? "");
    // Not a WETH-quoted pool: never guess the orientation.
    return a0 && a1 && (a0 === weth || a1 === weth) ? [{ pool, a0, a1 }] : [];
  });
  if (!usable.length) return;
  const decimals = await batch(
    rpcUrl,
    usable.flatMap((u) => [
      { to: u.a0, data: SEL_DECIMALS },
      { to: u.a1, data: SEL_DECIMALS },
    ]),
    fetchImpl,
  );
  usable.forEach((u, i) => {
    const d0 = decimals[i * 2];
    const d1 = decimals[i * 2 + 1];
    if (!d0 || !d1) return;
    const decimals0 = Number(BigInt(d0));
    const decimals1 = Number(BigInt(d1));
    if (!Number.isInteger(decimals0) || !Number.isInteger(decimals1)) return;
    META.set(u.pool, { token0IsWeth: u.a0 === weth, decimals0, decimals1 });
  });
}

export type ReferencePrices = {
  ts: number;
  prices: Record<string, number | null>;
};

/**
 * One reading of the reference price (token in WETH) for each symbol. A symbol without a pool, or whose pool cannot
 * be read, is `null`; nothing is invented. `rpcUrl` comes from server configuration, never from the request.
 */
export async function readReferencePrices(
  rpcUrl: string,
  symbols: string[],
  fetchImpl: Fetch = fetch,
): Promise<ReferencePrices> {
  const prices: Record<string, number | null> = {};
  const wanted = symbols.flatMap((symbol) => {
    const pool = referencePool(symbol);
    if (!pool) {
      prices[symbol] = null;
      return [];
    }
    return [{ symbol, pool }];
  });
  await loadMetas(
    rpcUrl,
    Array.from(new Set(wanted.map((w) => w.pool))),
    fetchImpl,
  );
  const readable = wanted.flatMap((w) => {
    const meta = META.get(w.pool);
    return meta ? [{ ...w, meta }] : [];
  });
  for (const w of wanted)
    if (!readable.some((r) => r.symbol === w.symbol)) prices[w.symbol] = null;
  if (readable.length) {
    const slots = await batch(
      rpcUrl,
      readable.map((r) => ({ to: r.pool, data: SEL_SLOT0 })),
      fetchImpl,
    );
    readable.forEach((r, i) => {
      const hex = slots[i] ?? "";
      prices[r.symbol] =
        hex.length < 66
          ? null
          : tokenPriceInWeth(
              BigInt(`0x${word(hex, 0)}`),
              r.meta.token0IsWeth,
              r.meta.decimals0,
              r.meta.decimals1,
            );
    });
  }
  return { ts: Date.now(), prices };
}
