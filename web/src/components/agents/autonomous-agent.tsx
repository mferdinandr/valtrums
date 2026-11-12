"use client";

import { useCallback, useEffect, useState } from "react";
import { useActionWallet, useWallet } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TransactionLink } from "@/components/transaction-link";
import { formatUnits } from "@/lib/amounts";
import { STRATEGY_OPTIONS, type AgentStrategy } from "@/lib/arena-read/agent-grant";
import type { Namespace } from "@/lib/arena-read/application";
import {
  buildAutonomousConfig,
  fundNearTransaction,
  fundTokenTransaction,
  newAgentKey,
  nearToYocto,
  readAgentStatus,
  runCommand,
  tokensToBase,
  type AgentKey,
  type AgentStatus,
  type WalletTransaction,
} from "@/lib/arena-read/autonomous-agent";
import { config } from "@/lib/config";

type Tx = { step: "idle" } | { step: "signing" } | { step: "done"; hash: string | null } | { step: "error"; message: string };

const POLL_MS = 15_000;
const short = (s: string) => (s.length > 18 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);
const symbolOf = (representation: string) => representation.replace(/^backing-/, "").split(".")[0]!.toUpperCase();

const download = (name: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

/**
 * An agent with its own account and balance that plays by itself. The key is made here in the browser and shown
 * once; no server stores it. The owner funds the agent from their own wallet, and whoever runs the agent process
 * holds the key. See docs/player-agents.md.
 */
export function AutonomousAgent({ namespace }: { namespace: Namespace }) {
  const { accountId } = useWallet();
  const getWallet = useActionWallet();
  const [key, setKey] = useState<AgentKey | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [strategy, setStrategy] = useState<AgentStrategy>("underdog");
  const [sweep, setSweep] = useState(false);
  const [keepWhole, setKeepWhole] = useState("100");
  const [nearAmount, setNearAmount] = useState("0.5");
  const [token, setToken] = useState("");
  const [tokenAmount, setTokenAmount] = useState("100");
  const [tx, setTx] = useState<Tx>({ step: "idle" });
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!key) return;
    try {
      setStatus(await readAgentStatus(config.rpcUrl, namespace.arenaContract, key.account));
      setStatusError(null);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : "read failed");
    }
  }, [key, namespace.arenaContract]);
  useEffect(() => {
    if (!key) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [key, refresh]);

  const keep = Number(keepWhole);
  const settings = { strategy, sweepTo: sweep && accountId ? accountId : "", keepWhole: Number.isInteger(keep) && keep >= 0 ? keep : 0 };
  const configText = key ? JSON.stringify(buildAutonomousConfig(key.account, settings), null, 2) : "";

  const send = async (transaction: WalletTransaction) => {
    setTx({ step: "signing" });
    try {
      if (!getWallet) throw new Error("connect a wallet first");
      const wallet = await getWallet();
      const out = await wallet.signAndSendTransaction(transaction as never);
      setTx({ step: "done", hash: (out as { transaction?: { hash?: string } } | null)?.transaction?.hash ?? null });
      void refresh();
    } catch (e) {
      setTx({ step: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const yocto = nearToYocto(nearAmount);
  const base = tokensToBase(tokenAmount);
  const chosenToken = token || status?.tokens[0]?.representation || "";

  return (
    <Card aria-label="Autonomous agent" className="space-y-4">
      <CardTitle>Agent with its own wallet</CardTitle>
      <p className="text-sm text-mute">
        A new agent that plays on its own: NEAR AI Cloud (private inference in a secure enclave) picks where to play and how much, and the agent joins and deposits with no approval step.
        The most it can lose is what you send it. Its key is made in your browser and shown once; we never store it.
      </p>

      {!key ? (
        <Button onClick={() => { setKey(newAgentKey()); setRevealed(false); setTx({ step: "idle" }); }}>Create agent</Button>
      ) : (
        <>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">1. Agent account</h3>
            <p className="break-all text-sm" aria-label="Agent account">{key.account}</p>
            <p className="text-xs text-mute">The account exists on chain once you send it NEAR (step 3).</p>
            <div className="space-y-2">
              <Button size="sm" variant="ghost" onClick={() => setRevealed((v) => !v)}>
                {revealed ? "Hide secret key" : "Show secret key (shown once, copy it now)"}
              </Button>
              {revealed && (
                <p role="alert" className="break-all rounded-lg border border-edge p-3 text-xs">
                  {key.secretKey}
                  <span className="mt-2 block text-neon-amber">
                    Anyone with this key controls the agent&apos;s funds. It is not saved anywhere. If you lose it, send the agent nothing more.
                  </span>
                </p>
              )}
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">2. Play style and surplus</h3>
            <p className="text-xs text-mute">The agent decides each play with AI. The style is only a hint.</p>
            <Select value={strategy} options={STRATEGY_OPTIONS} onChange={setStrategy} label="Play style" />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={sweep} disabled={!accountId} onChange={(e) => setSweep(e.target.checked)} />
              Send surplus tokens back to my wallet{accountId ? ` (${accountId})` : " (connect a wallet)"}
            </label>
            {sweep && (
              <div>
                <Label htmlFor="keep">Whole tokens to keep per token</Label>
                <Input id="keep" inputMode="numeric" value={keepWhole} onChange={(e) => setKeepWhole(e.target.value)} />
                <p className="mt-1 text-xs text-mute">The agent sends everything above this amount to you after each round. Your wallet must be registered on each token.</p>
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">3. Fund it from your wallet</h3>
            {!accountId ? (
              <p className="text-sm text-mute">Connect a wallet to fund the agent.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <Label htmlFor="near">NEAR for fees</Label>
                    <Input id="near" inputMode="decimal" value={nearAmount} onChange={(e) => setNearAmount(e.target.value)} />
                  </div>
                  <Button size="sm" disabled={!yocto || tx.step === "signing"} onClick={() => yocto && void send(fundNearTransaction(key.account, yocto))}>
                    Send NEAR
                  </Button>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <Label htmlFor="token">Token</Label>
                    <Select
                      label="Token"
                      className="min-w-40"
                      value={chosenToken}
                      options={(status?.tokens ?? []).map((t) => ({ value: t.representation, title: symbolOf(t.representation) }))}
                      onChange={setToken}
                      disabled={(status?.tokens.length ?? 0) === 0}
                    />
                  </div>
                  <div>
                    <Label htmlFor="amount">Whole tokens</Label>
                    <Input id="amount" inputMode="numeric" value={tokenAmount} onChange={(e) => setTokenAmount(e.target.value)} />
                  </div>
                  <Button size="sm" disabled={!base || !chosenToken || tx.step === "signing"} onClick={() => base && chosenToken && void send(fundTokenTransaction(chosenToken, key.account, base))}>
                    Send tokens
                  </Button>
                </div>
                <p className="text-xs text-mute">Sending tokens also registers the agent on that token. Get test tokens from the Faucet first.</p>
                {tx.step === "signing" && <p role="status" className="text-xs text-mute">Waiting for your wallet…</p>}
                {tx.step === "done" && (
                  <p role="status" className="text-xs">Sent. {tx.hash ? <TransactionLink hash={tx.hash} /> : null}</p>
                )}
                {tx.step === "error" && <p role="alert" className="text-xs text-neon-amber">{tx.message}</p>}
              </>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">4. Run it</h3>
            <p className="text-sm text-mute">
              The agent only plays while it is running, on your computer or a server. Download the config, then run the command with two secrets in the environment (never in the file): the agent&apos;s secret key as <code>PLAYER_KEY_MY_AGENT</code> and your NEAR AI Cloud key as <code>NEAR_AI_API_KEY</code>.
            </p>
            <Button size="sm" variant="ghost" onClick={() => download("my-agent.json", configText)}>Download config</Button>
            <pre className="max-h-48 overflow-auto rounded-lg border border-edge p-3 text-xs" aria-label="Run command">{runCommand("my-agent.json")}</pre>
            <p className="text-xs text-mute">Without <code>--live</code> it only prints what it would do. Details: docs/player-agents.md.</p>
          </section>

          <section className="space-y-2" aria-live="polite">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              5. Status <Badge tone={status?.nearYocto ? "green" : "amber"}>{status?.nearYocto ? "funded" : "not funded yet"}</Badge>
            </h3>
            {statusError && <p role="alert" className="text-xs text-neon-amber">Could not read the agent: {statusError}</p>}
            {status && (
              <>
                <p className="text-sm">NEAR: {status.nearYocto ? formatUnits(BigInt(status.nearYocto), 24, 4) : "0"}</p>
                <ul className="space-y-1 text-sm">
                  {status.tokens.filter((t) => t.base !== "0").map((t) => (
                    <li key={t.representation}>{symbolOf(t.representation)}: {formatUnits(BigInt(t.base), 18, 2)}</li>
                  ))}
                </ul>
                <h4 className="text-xs font-semibold text-mute">Recent plays</h4>
                {status.plays.length === 0 ? (
                  <p className="text-xs text-mute">No deposits in the latest battles yet.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {status.plays.map((p) => (
                      <li key={`${p.battleId}:${p.community}`}>
                        Battle #{p.battleId}: {formatUnits(BigInt(p.amount), 18, 2)} {symbolOf(p.representation)}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            <p className="text-xs text-mute">
              Winnings are not tokens in this balance. They are entitlements paid out on Robinhood Chain; see Portfolio. Agent: {short(key.account)}.
            </p>
          </section>
        </>
      )}
    </Card>
  );
}
