import { sha256Hex } from "../mcp/actions/canonical.js";

/**
 * FIXTURE custody for the fake solver: an in-memory ledger standing in for the arena's testnet
 * custody. It is NOT the EVM custody contract or the receipt registry; the real receipt path is
 * `custody-verifier.ts`. It records what a solver moved so the arena's credit handling can be
 * tested for duplicates, failures and refunds.
 */

export const FIXTURE_CHAIN_ID = "46630";

export interface CustodyReceipt {
  /** `delivery` moved the destination mock token to custody; `refund` returned the origin token. */
  kind: "delivery" | "refund";
  chainId: string;
  transactionHash: string;
  logIndex: number;
  /** Fixture asset id moved. */
  assetId: string;
  to: string;
  amount: string;
  /** Deposit address of the quote this settles; one quote settles at most once. */
  depositAddress: string;
}

export interface SolverCustody {
  deliver(input: { depositAddress: string; assetId: string; to: string; amount: bigint }): CustodyReceipt;
  refund(input: { depositAddress: string; assetId: string; to: string; amount: bigint }): CustodyReceipt;
}

export const receiptKey = (r: Pick<CustodyReceipt, "chainId" | "transactionHash" | "logIndex">): string =>
  `${r.chainId}:${r.transactionHash.toLowerCase()}:${r.logIndex}`;

/** In-memory custody: balances per (asset, holder), one settlement per deposit address. */
export class FixtureCustody implements SolverCustody {
  readonly receipts: CustodyReceipt[] = [];
  private readonly settled = new Map<string, CustodyReceipt>();
  private readonly balances = new Map<string, bigint>();

  balance(assetId: string, holder: string): bigint {
    return this.balances.get(`${assetId}|${holder}`) ?? 0n;
  }

  private move(kind: CustodyReceipt["kind"], input: { depositAddress: string; assetId: string; to: string; amount: bigint }): CustodyReceipt {
    // A second settlement of the same quote returns the first receipt and moves nothing.
    const prior = this.settled.get(input.depositAddress);
    if (prior) return prior;
    if (input.amount <= 0n) throw new Error("amount must be positive");
    const transactionHash = `0x${sha256Hex(`fixture-tx:${kind}:${input.depositAddress}`)}`;
    const receipt: CustodyReceipt = {
      kind,
      chainId: FIXTURE_CHAIN_ID,
      transactionHash,
      logIndex: 0,
      assetId: input.assetId,
      to: input.to,
      amount: input.amount.toString(),
      depositAddress: input.depositAddress,
    };
    const key = `${input.assetId}|${input.to}`;
    this.balances.set(key, (this.balances.get(key) ?? 0n) + input.amount);
    this.settled.set(input.depositAddress, receipt);
    this.receipts.push(receipt);
    return receipt;
  }

  deliver(input: { depositAddress: string; assetId: string; to: string; amount: bigint }): CustodyReceipt {
    return this.move("delivery", input);
  }

  refund(input: { depositAddress: string; assetId: string; to: string; amount: bigint }): CustodyReceipt {
    return this.move("refund", input);
  }
}

/**
 * The arena side of a funding: credits a delivery receipt to a user's balance exactly once, keyed
 * by the receipt identity. Refunds and failures never credit.
 */
export class FundingCredits {
  private readonly seen = new Set<string>();
  private readonly credits = new Map<string, bigint>();

  credit(user: string, receipt: CustodyReceipt): { credited: boolean; reason?: string } {
    if (receipt.kind !== "delivery") return { credited: false, reason: "only a delivery receipt credits" };
    const key = receiptKey(receipt);
    if (this.seen.has(key)) return { credited: false, reason: "receipt already credited" };
    this.seen.add(key);
    const k = `${receipt.assetId}|${user}`;
    this.credits.set(k, (this.credits.get(k) ?? 0n) + BigInt(receipt.amount));
    return { credited: true };
  }

  balance(assetId: string, user: string): bigint {
    return this.credits.get(`${assetId}|${user}`) ?? 0n;
  }
}
