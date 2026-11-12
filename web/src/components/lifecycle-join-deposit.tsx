"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { TokenIcon } from "@/components/token-icon";
import { Button } from "@/components/ui/button";
import { TransactionLink } from "@/components/transaction-link";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { useWallet } from "@/components/providers";
import { plainSymbol } from "@/lib/arena-read/token-name";
import { useBalances } from "@/hooks/use-balances";
import { useJoinableAssets } from "@/hooks/use-joinable-assets";
import { JOIN_STAGE_TEXT, useJoinAndDeposit } from "@/hooks/use-join-and-deposit";
import { formatUnits, parseUnits } from "@/lib/amounts";
import type { Namespace } from "@/lib/arena-read/application";
import { TOKEN_DECIMALS } from "@/lib/arena-read/balances";
import { firstDepositProblems } from "@/lib/arena-read/create-deposit";

/**
 * Deposit into an open battle in one step: pick a token (one already in the battle or a new one), type an amount
 * and press one button. Adding the token as a community, registering, waiting for its approvals and the deposit
 * itself are done by the button; the wallet only asks for confirmations.
 */
export function JoinDeposit({
  namespace, battleId, communityTokens,
}: {
  namespace: Namespace;
  battleId: number;
  /** Representations that are already communities of this battle. */
  communityTokens: readonly string[];
}) {
  const { signIn } = useWallet();
  const { balances } = useBalances();
  const joinable = useJoinableAssets(namespace.arenaContract);
  const flow = useJoinAndDeposit(namespace.arenaContract, battleId);
  const [token, setToken] = useState("");
  const [amount, setAmount] = useState("");

  // Tokens the account holds and the arena lets anyone join with; the ones already in the battle come first.
  const options = useMemo(() => {
    const listed = (joinable.items ?? []).map((a) => a.representation);
    return (balances?.tokens ?? [])
      .filter((t) => BigInt(t.balance) > 0n && listed.includes(t.token))
      .map((t) => ({ ...t, inBattle: communityTokens.includes(t.token) }))
      .sort((a, b) => Number(b.inBattle) - Number(a.inBattle));
  }, [balances, joinable.items, communityTokens]);
  const chosen = options.find((o) => o.token === token) ?? null;
  const amountBase = parseUnits(amount, TOKEN_DECIMALS)?.toString() ?? "";
  const problems = firstDepositProblems(token, amountBase, chosen ? chosen.balance : null);
  const label = chosen && amountBase ? `${formatUnits(BigInt(amountBase), TOKEN_DECIMALS, 4)} ${plainSymbol(chosen.symbol)}` : null;
  const st = flow.state;

  return (
    <Card aria-label="Deposit">
      <CardTitle>Deposit</CardTitle>
      {options.length === 0 ? (
        <p role="status" className="text-sm text-mute">
          {balances === null || joinable.items === null ? (
            joinable.error ? `Could not read the tokens: ${joinable.error}` : "Reading your tokens…"
          ) : (
            <>
              You hold no token this battle accepts. <Link href="/faucet" className="underline">Get some from the faucet</Link>.
            </>
          )}
        </p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="group" aria-label="Token to deposit">
            {options.map((o) => (
              <button
                key={o.token}
                type="button"
                className="lifecycle-mode !flex items-center gap-3"
                aria-pressed={token === o.token}
                disabled={st.step === "running"}
                onClick={() => setToken(o.token)}
              >
                <TokenIcon symbol={plainSymbol(o.symbol)} size={40} />
                <span className="min-w-0 flex-1">
                  <strong className="block truncate">{plainSymbol(o.symbol)}</strong>
                  <span className="block text-xs text-mute">Balance {formatUnits(BigInt(o.balance), TOKEN_DECIMALS, 4)}</span>
                </span>
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                  style={o.inBattle ? { background: "#327f7d22", color: "#327f7d" } : { background: "#e6e2d6", color: "#526777" }}
                >
                  {o.inBattle ? "In battle" : "New"}
                </span>
                {token === o.token && <Check size={16} aria-hidden="true" style={{ color: "#327f7d" }} />}
              </button>
            ))}
          </div>
          <Label>
            Amount
            <Input
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              disabled={st.step === "running"}
              onChange={(e) => setAmount(e.target.value.trim())}
            />
          </Label>
          {amount !== "" && problems.length > 0 && (
            <ul role="status" className="list-disc pl-4 text-xs text-neon-amber">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {flow.connected ? (
            <Button
              type="button"
              disabled={problems.length > 0 || st.step === "running" || !chosen}
              onClick={() => chosen && void flow.run(chosen.token, chosen.symbol, amountBase)}
            >
              {st.step === "failed" ? "Continue" : label ? `Deposit ${label}` : "Deposit"}
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={() => void signIn()}>
              Connect wallet to deposit
            </Button>
          )}
          {st.step === "running" && (
            <p role="status" className="text-xs text-mute">
              {JOIN_STAGE_TEXT[st.stage]} Confirm in your wallet when asked.
            </p>
          )}
          {st.step === "failed" && (
            <p role="alert" className="text-xs text-neon-amber">
              Deposit failed: {st.message}
            </p>
          )}
          {st.step === "done" && (
            <p role="status" className="text-xs text-neon-green">
              Deposited. Your position is listed above.
            </p>
          )}
        </div>
      )}
      {flow.txHashes?.length > 0 && <div className="mt-3 space-y-1"><p className="text-xs text-mute">Transactions from this session</p>{flow.txHashes.map((hash, i) => <div key={hash} className="text-xs"><span>Transaction {i + 1}</span><TransactionLink hash={hash} /></div>)}</div>}
    </Card>
  );
}
