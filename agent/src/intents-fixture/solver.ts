import type { CustodyReceipt, SolverCustody } from "./custody.js";

/**
 * FIXTURE solver (D29). It settles a funded quote by moving testnet mock tokens through
 * `SolverCustody`, and can be told to fail or refund so the arena's failure and refund handling is
 * exercised. It is not a market maker and has no relation to real 1Click solvers.
 */
export type SolverMode = "complete" | "fail" | "refund";

export interface SettleInput {
  depositAddress: string;
  originAssetId: string;
  destinationAssetId: string;
  /** Recipient of the destination token (the arena custody beneficiary). */
  recipient: string;
  refundTo: string;
  amountIn: bigint;
  amountOut: bigint;
}

export type SettleOutcome =
  | { status: "SUCCESS"; receipt: CustodyReceipt }
  | { status: "REFUNDED"; receipt: CustodyReceipt; reason: string }
  | { status: "FAILED"; reason: string };

export class FakeSolver {
  private perQuote = new Map<string, SolverMode>();

  constructor(
    private readonly custody: SolverCustody,
    private mode: SolverMode = "complete",
  ) {}

  setMode(mode: SolverMode): void {
    this.mode = mode;
  }

  /** Overrides the mode for one deposit address only. */
  setModeFor(depositAddress: string, mode: SolverMode): void {
    this.perQuote.set(depositAddress, mode);
  }

  settle(input: SettleInput): SettleOutcome {
    const mode = this.perQuote.get(input.depositAddress) ?? this.mode;
    if (mode === "fail") return { status: "FAILED", reason: "fixture solver was told to fail" };
    if (mode === "refund") {
      const receipt = this.custody.refund({ depositAddress: input.depositAddress, assetId: input.originAssetId, to: input.refundTo, amount: input.amountIn });
      return { status: "REFUNDED", receipt, reason: "fixture solver was told to refund" };
    }
    const receipt = this.custody.deliver({ depositAddress: input.depositAddress, assetId: input.destinationAssetId, to: input.recipient, amount: input.amountOut });
    return { status: "SUCCESS", receipt };
  }
}
