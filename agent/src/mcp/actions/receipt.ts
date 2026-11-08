import { canonicalJson } from "./canonical.js";
import type { UnsignedTransaction } from "./preview.js";

/**
 * A broadcast transaction hash proves nothing by itself. An action is confirmed only when a final
 * receipt shows the prepared transaction (same signer, receiver, method, arguments and deposit)
 * succeeded in every receipt; anything else stays pending or fails.
 */

export type ReceiptOutcome = { status: "pending"; reason: string } | { status: "success" } | { status: "failure"; reason: string };

export interface ReceiptVerifier {
  check(txHash: string, expected: UnsignedTransaction): Promise<ReceiptOutcome>;
}

interface RpcAction {
  FunctionCall?: { method_name: string; args: string; gas: number | string; deposit: string };
}
interface RpcTxResult {
  status?: Record<string, unknown>;
  transaction?: { signer_id: string; receiver_id: string; actions: (RpcAction | string)[] };
  receipts_outcome?: { outcome?: { status?: Record<string, unknown> } }[];
}

/** Compares the on-chain transaction with the prepared one; returns a mismatch or null. */
export function transactionMismatch(result: RpcTxResult, expected: UnsignedTransaction): string | null {
  const tx = result.transaction;
  if (!tx) return "no transaction in the receipt";
  if (tx.signer_id !== expected.signerId) return "signer differs from the prepared transaction";
  if (tx.receiver_id !== expected.receiverId) return "receiver differs from the prepared transaction";
  if (tx.actions.length !== expected.actions.length) return "action count differs from the prepared transaction";
  for (const [i, action] of tx.actions.entries()) {
    const want = expected.actions[i];
    const call = typeof action === "object" ? action.FunctionCall : undefined;
    if (!want || !call) return "transaction actions differ from the prepared transaction";
    if (call.method_name !== want.methodName) return "method differs from the prepared transaction";
    if (String(call.deposit) !== want.deposit) return "deposit differs from the prepared transaction";
    let args: unknown;
    try {
      args = JSON.parse(Buffer.from(call.args, "base64").toString("utf8"));
    } catch {
      return "arguments are not JSON";
    }
    if (canonicalJson(args) !== canonicalJson(want.args)) return "arguments differ from the prepared transaction";
  }
  return null;
}

export function outcomeOf(result: RpcTxResult, expected: UnsignedTransaction): ReceiptOutcome {
  const mismatch = transactionMismatch(result, expected);
  if (mismatch) return { status: "failure", reason: mismatch };
  const status = result.status ?? {};
  if ("Failure" in status) return { status: "failure", reason: "the transaction failed" };
  if (!("SuccessValue" in status) && !("SuccessReceiptId" in status)) return { status: "pending", reason: "no final status yet" };
  for (const receipt of result.receipts_outcome ?? []) {
    if (receipt.outcome?.status && "Failure" in receipt.outcome.status) {
      return { status: "failure", reason: "a receipt of the transaction failed" };
    }
  }
  return { status: "success" };
}

/** Reads the final transaction status from a NEAR RPC (`tx`, waiting for FINAL). */
export class NearRpcReceiptVerifier implements ReceiptVerifier {
  constructor(
    private readonly rpcUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async check(txHash: string, expected: UnsignedTransaction): Promise<ReceiptOutcome> {
    let body: { result?: RpcTxResult; error?: { cause?: { name?: string }; message?: string } };
    try {
      const res = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "valtrum-action",
          method: "tx",
          params: { tx_hash: txHash, sender_account_id: expected.signerId, wait_until: "FINAL" },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      body = (await res.json()) as typeof body;
    } catch {
      return { status: "pending", reason: "receipt not readable yet" };
    }
    if (body.error || !body.result) return { status: "pending", reason: "transaction not final or not found yet" };
    return outcomeOf(body.result, expected);
  }
}
