// Execution pipeline: verify -> fund (if needed) -> re-check -> verify -> send.
// The confirmed plan is frozen at confirmation time; every transaction is compared against it before signing.
// If funding fails or anything differs, nothing is deposited.

import type { FundingHooks, FundingQuote, FundingRouter } from "./funding";
import type { SendVia, TerminalChain, TxSender } from "./chain";
import type { DepositPlan } from "./plan";
import { buildDepositTx, verifyTx, type DepositTx } from "./transaction";

export interface ExecutionDeps {
  chain: TerminalChain;
  sender: TxSender;
  funding: FundingRouter;
  /** Test seam: lets a caller tamper with the transaction between build and verify. */
  buildTx?: (plan: DepositPlan) => DepositTx;
}

export type ExecutionStage = "verify" | "funding" | "balance" | "state" | "send";

export type ExecutionResult =
  | { ok: true; via: SendVia; tx: DepositTx }
  | { ok: false; stage: ExecutionStage; reason: string; /** Always false: nothing reached the arena. */ deposited: false };

/** Deep copy so later mutation of the live plan cannot change what the user confirmed. */
export function freezePlan(plan: DepositPlan): DepositPlan {
  return Object.freeze({
    ...plan,
    bridgeLegs: Object.freeze(plan.bridgeLegs.map((l) => Object.freeze({ ...l }))) as DepositPlan["bridgeLegs"],
    notes: Object.freeze([...plan.notes]) as unknown as string[],
  });
}

const abort = (stage: ExecutionStage, reason: string): ExecutionResult => ({ ok: false, stage, reason, deposited: false });

export interface ExecuteOptions {
  /** One accepted quote per bridge leg, in the same order as `plan.bridgeLegs`. */
  fundingQuotes?: FundingQuote[];
  fundingHooks?: FundingHooks;
  onStage?: (stage: "funding" | "depositing") => void;
}

export async function executeDeposit(
  confirmed: DepositPlan,
  live: DepositPlan,
  deps: ExecutionDeps,
  opts: ExecuteOptions = {},
): Promise<ExecutionResult> {
  const build = deps.buildTx ?? buildDepositTx;
  const check = (): ExecutionResult | DepositTx => {
    const tx = build(live);
    const v = verifyTx(confirmed, tx);
    return v.ok ? tx : abort("verify", `The transaction differs from what you confirmed: ${v.mismatches.join("; ")}`);
  };

  const early = check();
  if (!("method" in early)) return early;

  const quotes = opts.fundingQuotes ?? [];
  if (confirmed.bridgeLegs.length !== quotes.length) return abort("funding", "Every cross-chain transfer needs a confirmed quote");
  if (quotes.length > 0) {
    opts.onStage?.("funding");
    for (const [i, quote] of quotes.entries()) {
      const leg = confirmed.bridgeLegs[i]!;
      if (quote.chain !== leg.chain || quote.amountIn !== leg.amount) return abort("funding", "A funding quote does not match the confirmed summary");
      const res = await deps.funding.execute(quote, opts.fundingHooks);
      if (!res.ok) return abort("funding", `Funding failed, nothing was deposited: ${res.reason}`);
    }
  }

  // Funds and credit may have moved while we waited; the deposit must still be what was confirmed.
  const split = await deps.chain.previewFunding(confirmed.accountId, confirmed.totalUnits);
  if (split.fromCredit !== confirmed.creditUnits || split.fromWallet !== confirmed.walletUnits) {
    return abort("state", "Your credit changed while preparing the deposit. Nothing was sent; please run the command again.");
  }
  const balance = await deps.chain.usdcBalance(confirmed.accountId);
  if (balance < confirmed.walletUnits) {
    return abort("balance", "The wallet does not hold enough USDC after funding. Nothing was deposited.");
  }

  const tx = check();
  if (!("method" in tx)) return tx;
  opts.onStage?.("depositing");
  try {
    const via = await deps.sender.send(tx, confirmed.accountId);
    return { ok: true, via, tx };
  } catch (e) {
    return abort("send", e instanceof Error ? e.message : "The deposit transaction failed");
  }
}
