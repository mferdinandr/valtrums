import type { CallReview } from "./create-review";
import type { ActionWallet } from "@/lib/terminal/actions";

/** Only transaction-relevant data binds a preview, never labels or object reference equality. */
export function reviewScopeKey(
  account: string | null,
  namespace: string,
  request: Record<string, unknown>,
  review: CallReview | null,
): string {
  return JSON.stringify([
    account,
    namespace,
    request,
    review && [
      review.receiver,
      review.method,
      review.args,
      review.depositYocto,
      review.gasTgas,
    ],
  ]);
}

/** An epoch also rejects A -> B -> A responses and repeated requests for the same draft. */
export class ReviewScope {
  private key = "";
  private epoch = 0;
  select(key: string) {
    if (key !== this.key) {
      this.key = key;
      this.epoch++;
    }
  }
  begin() {
    return ++this.epoch;
  }
  current(token: number) {
    return token === this.epoch;
  }
  invalidate() {
    this.epoch++;
  }
}

/** Recheck after asynchronous session preparation AND before each consequential wallet prompt. */
export function scopeWallet(
  wallet: ActionWallet,
  current: () => boolean,
): ActionWallet {
  const check = () => {
    if (!current())
      throw new Error(
        "Battle details changed. Review them and request a new preview.",
      );
  };
  return {
    signMessage: async (message) => {
      check();
      const proof = await wallet.signMessage(message);
      check();
      return proof;
    },
    signAndSend: async (transaction) => {
      check();
      return wallet.signAndSend(transaction);
    },
  };
}
