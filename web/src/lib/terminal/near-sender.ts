// Real NEAR sender: one wallet approval per transaction, or a session key when the policy allows it.

import { Amount, Near, fromHotConnect } from "near-kit";
import type { SendVia, TxSender } from "./chain";
import { canSessionSign, type StoredSession } from "./session-key";
import type { DepositTx } from "./transaction";

type HotConnector = Parameters<typeof fromHotConnect>[0];

export interface NearSenderOptions {
  network: "testnet" | "mainnet";
  rpcUrl: string;
  connector: HotConnector;
  getSession?: () => StoredSession | null;
  now?: () => number;
}

export function createNearSender(opts: NearSenderOptions): TxSender {
  const wallet = new Near({ network: opts.network, rpcUrl: opts.rpcUrl, wallet: fromHotConnect(opts.connector) });
  const now = opts.now ?? Date.now;
  return {
    async send(tx: DepositTx, signerId: string): Promise<SendVia> {
      const session = opts.getSession?.() ?? null;
      const check = canSessionSign(session?.policy ?? null, { receiverId: tx.receiverId, method: tx.method, deposit: tx.deposit === "1" ? "1" : "0" }, now());
      if (session && check.ok) {
        const key = new Near({ network: opts.network, rpcUrl: opts.rpcUrl, privateKey: session.secretKey as `ed25519:${string}` });
        await key.call(tx.receiverId, tx.method, tx.args, { signerId, gas: tx.gas as `${number} Tgas` });
        return "session";
      }
      // Anything outside the session scope (every USDC transfer, for instance) goes to the wallet.
      await wallet.call(tx.receiverId, tx.method, tx.args, {
        signerId,
        gas: tx.gas as `${number} Tgas`,
        attachedDeposit: Amount.yocto(BigInt(tx.deposit)),
      });
      return "wallet";
    },
  };
}
