// NEAR Intents (1Click API) funding.
//  - `createOneClickService` talks to the 1Click REST API and runs server-side only (it may hold a JWT).
//  - `createIntentsFundingRouter` is the browser-side FundingRouter; it goes through our own route handler.
// 1Click flow: dry quote -> show it -> committed quote (deposit address) -> user sends funds -> poll status.

import { SUPPORTED_CHAINS } from "./intent";
import type { FundingHooks, FundingQuote, FundingRequest, FundingResult, FundingRouter } from "./funding";

export const ONECLICK_DEFAULT_URL = "https://1click.chaindefuser.com";
const TERMINAL_FAILURE = new Set(["FAILED", "REFUNDED", "INCOMPLETE_DEPOSIT"]);

interface Token {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
}

export interface OneClickQuoteInput {
  chain: string;
  amount: string;
  recipient: string;
  refundTo: string;
  slippageBps: number;
}

export interface OneClickQuoteOutput {
  amountIn: string;
  minAmountOut: string;
  etaSecs: number;
  deadlineMs: number;
  depositAddress: string | null;
}

export interface OneClickService {
  quote(input: OneClickQuoteInput, commit: boolean): Promise<OneClickQuoteOutput>;
  status(depositAddress: string): Promise<{ status: string; amountOut: string | null }>;
}

export interface OneClickOptions {
  baseUrl: string;
  /** Optional JWT; without it 1Click applies a higher fee. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export function createOneClickService(opts: OneClickOptions): OneClickService {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  let tokens: Promise<Token[]> | null = null;

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await doFetch(`${base}${path}`, { ...init, headers });
    if (!res.ok) throw new Error(`1Click request failed (HTTP ${res.status})`);
    return (await res.json()) as T;
  };
  const loadTokens = () => (tokens ??= request<Token[]>("/v0/tokens"));

  return {
    async quote(input, commit) {
      if (!(SUPPORTED_CHAINS as readonly string[]).includes(input.chain)) throw new Error("Unsupported chain");
      const list = await loadTokens();
      const origin = list.find((t) => t.symbol === "USDC" && t.blockchain === input.chain);
      const dest = list.find((t) => t.symbol === "USDC" && t.blockchain === "near");
      if (!origin || !dest) throw new Error(`USDC routing from ${input.chain} to NEAR is not available`);
      const body = await request<{
        quote: { depositAddress?: string; amountIn: string; minAmountOut?: string; amountOut: string; timeEstimate?: number; deadline?: string };
      }>("/v0/quote", {
        method: "POST",
        body: JSON.stringify({
          dry: !commit,
          swapType: "EXACT_INPUT",
          originAsset: origin.assetId,
          destinationAsset: dest.assetId,
          amount: input.amount,
          recipient: input.recipient,
          refundTo: input.refundTo,
          slippageTolerance: input.slippageBps,
          depositType: "ORIGIN_CHAIN",
          recipientType: "DESTINATION_CHAIN",
          refundType: "ORIGIN_CHAIN",
        }),
      });
      const q = body.quote;
      return {
        amountIn: q.amountIn,
        minAmountOut: q.minAmountOut ?? q.amountOut,
        etaSecs: q.timeEstimate ?? 60,
        deadlineMs: q.deadline ? Date.parse(q.deadline) : Date.now() + 10 * 60_000,
        depositAddress: commit ? (q.depositAddress ?? null) : null,
      };
    },
    async status(depositAddress) {
      const r = await request<{ status: string; swapDetails?: { amountOut?: string } }>(
        `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
      );
      return { status: r.status, amountOut: r.swapDetails?.amountOut ?? null };
    },
  };
}

export interface IntentsRouterOptions {
  fetchImpl?: typeof fetch;
  url?: string;
  slippageBps?: number;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Browser-side router: every call goes to `/api/terminal/funding`, so no key or third-party call happens here. */
export function createIntentsFundingRouter(opts: IntentsRouterOptions = {}): FundingRouter {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = opts.url ?? "/api/terminal/funding";
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const post = async <T>(body: unknown): Promise<T> => {
    const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `Funding request failed (HTTP ${res.status})`);
    return json;
  };
  const requests = new Map<string, FundingRequest>();

  return {
    kind: "intents",
    async quote(req: FundingRequest): Promise<FundingQuote> {
      const q = await post<OneClickQuoteOutput>({
        action: "quote",
        chain: req.chain,
        amount: req.amount.toString(),
        recipient: req.recipient,
        refundTo: req.refundTo,
        slippageBps: opts.slippageBps ?? 50,
      });
      const amountIn = BigInt(q.amountIn);
      const minOut = BigInt(q.minAmountOut);
      const quote: FundingQuote = {
        id: `${req.chain}:${req.amount}:${q.deadlineMs}`,
        chain: req.chain,
        amountIn,
        minAmountOut: minOut,
        feeUnits: amountIn > minOut ? amountIn - minOut : 0n,
        etaSecs: q.etaSecs,
        expiresAtMs: q.deadlineMs,
      };
      requests.set(quote.id, req);
      return quote;
    },
    async execute(quote: FundingQuote, hooks?: FundingHooks): Promise<FundingResult> {
      const req = requests.get(quote.id);
      if (!req) return { ok: false, reason: "Unknown quote" };
      try {
        const committed = await post<OneClickQuoteOutput>({
          action: "commit",
          chain: req.chain,
          amount: req.amount.toString(),
          recipient: req.recipient,
          refundTo: req.refundTo,
          slippageBps: opts.slippageBps ?? 50,
        });
        if (!committed.depositAddress) return { ok: false, reason: "No deposit address was issued" };
        hooks?.onDepositAddress?.({ chain: req.chain, address: committed.depositAddress, amount: BigInt(committed.amountIn) });
        const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
        while (Date.now() < deadline) {
          const s = await post<{ status: string; amountOut: string | null }>({ action: "status", depositAddress: committed.depositAddress });
          hooks?.onStatus?.(s.status);
          if (s.status === "SUCCESS") return { ok: true, received: s.amountOut ? BigInt(s.amountOut) : BigInt(committed.minAmountOut) };
          if (TERMINAL_FAILURE.has(s.status)) return { ok: false, reason: `Funding ended as ${s.status}` };
          await sleep(opts.pollMs ?? 4000);
        }
        return { ok: false, reason: "Funding timed out before the transfer arrived" };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : "Funding failed" };
      }
    },
  };
}
