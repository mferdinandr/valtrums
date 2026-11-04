// Cross-chain funding: bring USDC from another chain to the NEAR wallet before the deposit.
// `FundingRouter` is the seam; the mock is the default and used in tests, the 1Click client is behind an env flag.

export interface FundingRequest {
  chain: string;
  /** USDC base units (6 decimals) to bring in. */
  amount: bigint;
  /** NEAR account that receives the USDC. */
  recipient: string;
  /** Address on the origin chain that gets the funds back if the transfer fails. */
  refundTo: string;
}

export interface FundingQuote {
  id: string;
  chain: string;
  amountIn: bigint;
  /** Guaranteed minimum USDC arriving on NEAR. */
  minAmountOut: bigint;
  /** `amountIn - minAmountOut`, shown to the user as the fee. */
  feeUnits: bigint;
  etaSecs: number;
  expiresAtMs: number;
}

export type FundingResult = { ok: true; received: bigint } | { ok: false; reason: string };

export interface FundingHooks {
  /** The user has to send `amount` on `chain` to this address from their own wallet. */
  onDepositAddress?: (info: { chain: string; address: string; amount: bigint }) => void;
  onStatus?: (status: string) => void;
}

export interface FundingRouter {
  readonly kind: "mock" | "intents";
  /** Request and return a quote. Moves no funds. */
  quote(req: FundingRequest): Promise<FundingQuote>;
  /** Execute a quote that the user confirmed. Resolves with the amount that reached NEAR, never throws. */
  execute(quote: FundingQuote, hooks?: FundingHooks): Promise<FundingResult>;
}

export interface MockFundingOptions {
  /** Fee in basis points of the amount. Default 10 (0.1%). */
  feeBps?: number;
  now?: () => number;
  /** Called with the amount that "arrived" so a mock wallet can be credited. */
  onArrived?: (recipient: string, amount: bigint) => void;
  /** Force `execute` to fail with this reason. */
  failWith?: string;
}

export interface MockFundingRouter extends FundingRouter {
  readonly executed: FundingQuote[];
  setFailure(reason: string | null): void;
}

export function createMockFundingRouter(opts: MockFundingOptions = {}): MockFundingRouter {
  const now = opts.now ?? Date.now;
  const feeBps = BigInt(opts.feeBps ?? 10);
  const recipients = new Map<string, string>();
  const executed: FundingQuote[] = [];
  let failure = opts.failWith ?? null;
  let seq = 0;
  return {
    kind: "mock",
    executed,
    setFailure(reason) {
      failure = reason;
    },
    async quote(req) {
      const fee = (req.amount * feeBps) / 10_000n;
      const q: FundingQuote = {
        id: `mock-${++seq}`,
        chain: req.chain,
        amountIn: req.amount,
        minAmountOut: req.amount - fee,
        feeUnits: fee,
        etaSecs: 30,
        expiresAtMs: now() + 10 * 60_000,
      };
      recipients.set(q.id, req.recipient);
      return q;
    },
    async execute(quote, hooks) {
      if (failure) return { ok: false, reason: failure };
      if (quote.expiresAtMs <= now()) return { ok: false, reason: "The quote expired" };
      hooks?.onStatus?.("SUCCESS");
      executed.push(quote);
      opts.onArrived?.(recipients.get(quote.id) ?? "", quote.minAmountOut);
      return { ok: true, received: quote.minAmountOut };
    },
  };
}
