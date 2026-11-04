import type { HttpClient } from "./http.js";

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: string;
  quoteToken: string;
  /** Decimal string as returned by the API, USD per whole base token. Null if our token is the quote. */
  priceUsd: string | null;
  liquidityUsd: number;
  buys24h: number;
  sells24h: number;
}

export interface DexScreenerOptions {
  http: HttpClient;
  /** Optional key, sent as X-API-KEY. The public endpoint works without one. */
  apiKey?: string | undefined;
  baseUrl?: string;
  /** DexScreener chain id to read pairs from. Default "near". */
  chainId?: string;
  /**
   * Maps an arena token id to the address DexScreener knows it by. Useful on
   * testnet, where mock tokens have no market and must mirror a real token.
   */
  tokenAliases?: Record<string, string>;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Thin DexScreener reader: all pairs of a token on one chain. */
export class DexScreenerClient {
  private readonly http: HttpClient;
  private readonly baseUrl: string;
  private readonly chainId: string;
  private readonly headers: Record<string, string>;
  private readonly aliases: Record<string, string>;

  constructor(opts: DexScreenerOptions) {
    this.http = opts.http;
    this.baseUrl = opts.baseUrl ?? "https://api.dexscreener.com";
    this.chainId = opts.chainId ?? "near";
    this.headers = opts.apiKey ? { "X-API-KEY": opts.apiKey } : {};
    this.aliases = opts.tokenAliases ?? {};
  }

  async getPairs(token: string): Promise<DexPair[]> {
    const address = this.aliases[token] ?? token;
    const body = (await this.http.getJson(
      `${this.baseUrl}/latest/dex/tokens/${encodeURIComponent(address)}`,
      this.headers,
    )) as { pairs?: unknown } | null;
    if (!body || typeof body !== "object") throw new Error("unexpected DexScreener response");
    if (body.pairs === null || body.pairs === undefined) return [];
    if (!Array.isArray(body.pairs)) throw new Error("unexpected DexScreener response");

    const pairs: DexPair[] = [];
    for (const raw of body.pairs as Record<string, any>[]) {
      if (raw?.chainId !== this.chainId) continue;
      const base = String(raw.baseToken?.address ?? "");
      const quote = String(raw.quoteToken?.address ?? "");
      if (base !== address && quote !== address) continue;
      pairs.push({
        chainId: String(raw.chainId),
        dexId: String(raw.dexId ?? ""),
        pairAddress: String(raw.pairAddress ?? ""),
        baseToken: base,
        quoteToken: quote,
        // priceUsd quotes the base token; only use it when our token is the base.
        priceUsd: base === address && raw.priceUsd != null ? String(raw.priceUsd) : null,
        liquidityUsd: num(raw.liquidity?.usd),
        buys24h: num(raw.txns?.h24?.buys),
        sells24h: num(raw.txns?.h24?.sells),
      });
    }
    return pairs;
  }
}
