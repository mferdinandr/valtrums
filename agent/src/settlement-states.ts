import type { PayoutState, PayoutView } from "./payout-status.js";

/**
 * Read model of one holder's reward in one losing token, split into disjoint states.
 * Amounts are representation units of that token's backing. Only `confirmed` is paid:
 * a signature, a broadcast hash or a pending-finality report is never payment.
 */
export interface TokenSettlementStates {
  backing: string;
  holder: string;
  /** Sum of the holder's immutable allocations in this token. */
  entitled: bigint;
  /** Still in the entitlement; includes amounts restored after proven no-spend. */
  available: bigint;
  /** Reserved for a payout that is not yet broadcast (including signed, reverted, held). */
  reserved: bigint;
  /** A signed attempt was sent to the network; finality not observed. */
  broadcast: bigint;
  /** Observed on the network or held after a possible spend; not final. */
  confirmationPending: bigint;
  /** Final debit verified by the payout authority. */
  confirmed: bigint;
  /** available + reserved + broadcast + confirmationPending + confirmed === entitled. */
  balanced: boolean;
  /** Reward can be requested now (independent of any DAO decision on principal). */
  payable: boolean;
  /** Request ids of payouts that are neither confirmed nor restored. */
  openRequests: string[];
}

type Bucket = "reserved" | "broadcast" | "confirmationPending" | "confirmed" | "restored";

/** Tolerates attempts that may have reached the network. */
function mayHaveSpent(view: PayoutView): boolean {
  return view.attempts.some((a) => a.state === "broadcast" || a.state === "pending");
}

export function bucketOfPayout(view: PayoutView): Bucket {
  const state: PayoutState = view.state;
  switch (state) {
    case "confirmed":
      return "confirmed";
    case "restored":
      return "restored";
    case "broadcast":
      return "broadcast";
    case "pending_finality":
      return "confirmationPending";
    case "reconciliation_required":
      return mayHaveSpent(view) ? "confirmationPending" : "reserved";
    case "authorized":
    case "signing_requested":
    case "signed":
    case "reverted":
      return "reserved";
    default: {
      // Unknown future state: keep the funds reserved rather than call them available or paid.
      return "reserved";
    }
  }
}

export interface TokenStateInput {
  backing: string;
  holder: string;
  entitled: bigint;
  /** `entitlement_of(holder)` on the backing, after reservations were taken out. */
  available: bigint;
  payouts: PayoutView[];
  sourceDecimals: number;
  representationDecimals: number;
}

function toRepresentation(amount: bigint, source: number, representation: number): bigint {
  if (representation >= source) return amount * 10n ** BigInt(representation - source);
  const factor = 10n ** BigInt(source - representation);
  if (amount % factor !== 0n) throw new Error("payout amount not representable");
  return amount / factor;
}

const hex = (bytes: number[]): string => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

/** Pure: same inputs always give the same result, so a retried read changes nothing. */
export function buildTokenSettlementStates(input: TokenStateInput): TokenSettlementStates {
  const seen = new Map<string, PayoutView>();
  for (const view of input.payouts) {
    if (view.backing !== input.backing || view.holder !== input.holder) {
      throw new Error("payout belongs to another backing or holder");
    }
    const key = hex(view.request_id);
    const previous = seen.get(key);
    if (previous) {
      // A retried request is the same payout; a different record under one id is a conflict.
      if (JSON.stringify(previous) !== JSON.stringify(view)) {
        throw new Error("conflicting payout views for one request id");
      }
      continue;
    }
    seen.set(key, view);
  }
  const totals = { reserved: 0n, broadcast: 0n, confirmationPending: 0n, confirmed: 0n };
  const openRequests: string[] = [];
  for (const [key, view] of seen) {
    const bucket = bucketOfPayout(view);
    if (bucket === "restored") continue; // already back in `available`
    const amount = toRepresentation(
      BigInt(view.amount),
      input.sourceDecimals,
      input.representationDecimals,
    );
    totals[bucket as keyof typeof totals] += amount;
    if (bucket !== "confirmed") openRequests.push(key);
  }
  const sum = input.available + totals.reserved + totals.broadcast + totals.confirmationPending + totals.confirmed;
  return {
    backing: input.backing,
    holder: input.holder,
    entitled: input.entitled,
    available: input.available,
    ...totals,
    balanced: sum === input.entitled,
    payable: input.available > 0n,
    openRequests,
  };
}

/** Wire shapes of the backing views this model reads (u8 arrays, u128 as strings). */
export interface AllocationWire {
  beneficiary: string;
  amount: string;
}

export interface ViewCaller {
  view<T>(contractId: string, method: string, args: object): Promise<T | null | undefined>;
}

export interface TokenQuery {
  backing: string;
  holder: string;
  /** Allocation ids from the settlement plan for this token and holder. */
  allocationIds: number[][];
  /** Request ids the holder used for payouts in this token. */
  requestIds: number[][];
  sourceDecimals: number;
  representationDecimals: number;
}

/**
 * Read one holder's states per losing token. Tokens are read independently, so one
 * backing failing does not hide the others: its entry carries the error instead.
 */
export async function readSettlementStates(
  caller: ViewCaller,
  payoutContract: string,
  queries: TokenQuery[],
): Promise<Array<{ backing: string; states?: TokenSettlementStates; error?: string }>> {
  return Promise.all(
    queries.map(async (q) => {
      try {
        const ids = new Map(q.allocationIds.map((id) => [hex(id), id]));
        let entitled = 0n;
        for (const id of ids.values()) {
          const allocation = await caller.view<AllocationWire>(q.backing, "get_allocation", {
            allocation_id: id,
          });
          if (!allocation) continue; // not allocated yet: contributes nothing
          if (allocation.beneficiary !== q.holder) throw new Error("allocation for another holder");
          entitled += BigInt(allocation.amount);
        }
        const available = BigInt(
          (await caller.view<string>(q.backing, "entitlement_of", { account: q.holder })) ?? "0",
        );
        const payouts: PayoutView[] = [];
        for (const requestId of new Map(q.requestIds.map((id) => [hex(id), id])).values()) {
          const payout = await caller.view<PayoutView>(payoutContract, "get_payout", {
            backing: q.backing,
            holder: q.holder,
            request_id: requestId,
          });
          if (payout) payouts.push(payout);
        }
        return {
          backing: q.backing,
          states: buildTokenSettlementStates({
            backing: q.backing,
            holder: q.holder,
            entitled,
            available,
            payouts,
            sourceDecimals: q.sourceDecimals,
            representationDecimals: q.representationDecimals,
          }),
        };
      } catch (err) {
        return { backing: q.backing, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}
