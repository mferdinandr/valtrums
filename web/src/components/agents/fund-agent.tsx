"use client";

import { useState } from "react";
import { useActionWallet, useWallet } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TransactionLink } from "@/components/transaction-link";
import { fundNearTransaction, fundTokenTransaction, nearToYocto, tokensToBase, type AgentStatus, type WalletTransaction } from "@/lib/arena-read/autonomous-agent";

type Tx = { step: "idle" } | { step: "signing" } | { step: "done"; hash: string | null } | { step: "error"; message: string };

export const symbolOf = (representation: string) => representation.replace(/^backing-/, "").split(".")[0]!.toUpperCase();

/** Sends NEAR and tokens from the owner's own wallet to an agent account. Shared by both agent kinds. */
export function FundAgent({ account, tokens, onSent }: { account: string; tokens: AgentStatus["tokens"]; onSent?: () => void }) {
  const { accountId } = useWallet();
  const getWallet = useActionWallet();
  const [nearAmount, setNearAmount] = useState("0.5");
  const [token, setToken] = useState("");
  const [tokenAmount, setTokenAmount] = useState("100");
  const [tx, setTx] = useState<Tx>({ step: "idle" });

  const send = async (transaction: WalletTransaction) => {
    setTx({ step: "signing" });
    try {
      if (!getWallet) throw new Error("connect a wallet first");
      const wallet = await getWallet();
      const out = await wallet.signAndSendTransaction(transaction as never);
      setTx({ step: "done", hash: (out as { transaction?: { hash?: string } } | null)?.transaction?.hash ?? null });
      onSent?.();
    } catch (e) {
      setTx({ step: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  if (!accountId) return <p className="text-sm text-mute">Connect a wallet to fund the agent.</p>;
  const yocto = nearToYocto(nearAmount);
  const base = tokensToBase(tokenAmount);
  const chosen = token || tokens[0]?.representation || "";
  const busy = tx.step === "signing";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor={`near-${account}`}>NEAR for fees</Label>
          <Input id={`near-${account}`} inputMode="decimal" value={nearAmount} onChange={(e) => setNearAmount(e.target.value)} />
        </div>
        <Button size="sm" disabled={!yocto || busy} onClick={() => yocto && void send(fundNearTransaction(account, yocto))}>
          Send NEAR
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor={`token-${account}`}>Token</Label>
          <Select
            label="Token"
            className="min-w-40"
            value={chosen}
            options={tokens.map((t) => ({ value: t.representation, title: symbolOf(t.representation) }))}
            onChange={setToken}
            disabled={tokens.length === 0}
          />
        </div>
        <div>
          <Label htmlFor={`amount-${account}`}>Whole tokens</Label>
          <Input id={`amount-${account}`} inputMode="numeric" value={tokenAmount} onChange={(e) => setTokenAmount(e.target.value)} />
        </div>
        <Button size="sm" disabled={!base || !chosen || busy} onClick={() => base && chosen && void send(fundTokenTransaction(chosen, account, base))}>
          Send tokens
        </Button>
      </div>
      <p className="text-xs text-mute">Get test tokens from the Faucet first.</p>
      {tx.step === "signing" && <p role="status" className="text-xs text-mute">Waiting for your wallet…</p>}
      {tx.step === "done" && <p role="status" className="text-xs">Sent. {tx.hash ? <TransactionLink hash={tx.hash} /> : null}</p>}
      {tx.step === "error" && <p role="alert" className="text-xs text-neon-amber">{tx.message}</p>}
    </div>
  );
}
