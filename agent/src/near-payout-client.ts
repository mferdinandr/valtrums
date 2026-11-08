import type { NearTransport } from "./near-client.js";
import type { Hash, PayoutLedger } from "./payout-reconciler.js";
import type { PayoutHoldReason, PayoutPage, PayoutView } from "./payout-status.js";

/** Gas for payout calls that only change state or call the backing once. */
const PAYOUT_CALL_GAS = "100 Tgas";
/** Every privileged payout method requires exactly one yoctoNEAR. */
const ONE_YOCTO = "1 yocto";
const PAGE_LIMIT = "50";

/**
 * PayoutLedger over the payout contract. Only the relayer transport exists
 * here: the operator-only methods (`confirm_payout`, `record_revert`,
 * `restore_payout`) are deliberately not implemented, so this process can
 * never call them (owner decision, see the implementation notes).
 */
export class NearPayoutLedger implements PayoutLedger {
  constructor(
    private readonly contractId: string,
    private readonly relayer: NearTransport,
  ) {}

  private key(p: PayoutView): { backing: string; holder: string; request_id: Hash } {
    return { backing: p.backing, holder: p.holder, request_id: p.request_id };
  }

  private async write(transport: NearTransport, method: string, args: object): Promise<void> {
    await transport.call(this.contractId, method, args, PAYOUT_CALL_GAS, ONE_YOCTO);
  }

  async listOpenPayouts(): Promise<PayoutView[]> {
    const total = BigInt(
      String(await this.relayer.view<string>(this.contractId, "get_payout_count", {})),
    );
    const out: PayoutView[] = [];
    let from = 0n;
    while (from < total) {
      const page = await this.relayer.view<PayoutPage>(this.contractId, "list_open_payouts", {
        from_index: from.toString(),
        limit: PAGE_LIMIT,
      });
      if (!page) throw new Error("list_open_payouts returned nothing");
      out.push(...page.items);
      const next = BigInt(page.next_index);
      // A page that does not advance would loop forever; stop and let the pass fail closed.
      if (next <= from) throw new Error("list_open_payouts did not advance");
      from = next;
    }
    return out;
  }

  async getSignedTransaction(p: PayoutView, txHash: Hash): Promise<string | null> {
    return (
      (await this.relayer.view<string | null>(this.contractId, "get_signed_transaction", {
        ...this.key(p),
        tx_hash: txHash,
      })) ?? null
    );
  }

  recordBroadcast(p: PayoutView, txHash: Hash): Promise<void> {
    return this.write(this.relayer, "record_broadcast", { ...this.key(p), tx_hash: txHash });
  }

  recordPendingFinality(p: PayoutView, txHash: Hash): Promise<void> {
    return this.write(this.relayer, "record_pending_finality", { ...this.key(p), tx_hash: txHash });
  }

  requireReconciliation(p: PayoutView, reason: PayoutHoldReason): Promise<void> {
    return this.write(this.relayer, "require_reconciliation", { ...this.key(p), reason });
  }
}
