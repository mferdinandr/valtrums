"use client";

import { useCallback, useEffect, useState } from "react";
import { FundAgent, symbolOf } from "@/components/agents/fund-agent";
import { useActionWallet, useWallet } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatUnits } from "@/lib/amounts";
import { STRATEGY_OPTIONS, type AgentStrategy } from "@/lib/arena-read/agent-grant";
import type { Namespace } from "@/lib/arena-read/application";
import { readAgentStatus, type AgentStatus } from "@/lib/arena-read/autonomous-agent";
import { config } from "@/lib/config";
import { getHostedClient, type AgentActivity, type HostedAgentsClient, type HostedAgentView } from "@/lib/hosted-agents";

const POLL_MS = 15_000;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const ACTIVITY_POLL_MS = 5_000;
const amountText = (base?: string) => (base && /^[0-9]{1,60}$/.test(base) ? formatUnits(BigInt(base), 18, 2) : null);

/** An error without the contract account, method and "Smart contract panicked" noise. */
const plainError = (message?: string): string =>
  (message ?? "unknown error").replace(/^Contract call failed: \S+ - /, "").replace(/^Smart contract panicked: /, "").slice(0, 160);

/** One plain-language line for an agent event. No addresses or arguments; the transaction link is separate. */
function describeActivity(a: AgentActivity): string {
  const where = a.battleId !== undefined ? `battle #${a.battleId}` : "a battle";
  const amount = amountText(a.amount);
  switch (a.event) {
    case "start": return "Started playing";
    case "stop": return "Stopped";
    case "skipped": return `Waiting: ${a.reason ?? "nothing to do right now"}`;
    case "no_option": return "No open battle fits right now";
    case "model_answer_rejected": return "The AI's pick was not usable, so the agent waited";
    case "sent": return `Sent a step for ${where}${a.step ? ` (${a.step})` : ""}`;
    case "played": return `Played ${where}${amount ? `: deposited ${amount}` : ""}${a.decidedBy === "near-ai" ? " (picked by NEAR AI)" : ""}`;
    case "error": return `Problem: ${plainError(a.message)}`;
    case "sweep_skipped": return `Did not send surplus back: ${a.reason ?? "not possible yet"}`;
    case "swept": return `Sent surplus tokens back to your wallet${amount ? ` (${amount})` : ""}`;
    default: return a.event;
  }
}

/** Colour of a log line by what happened, on the dark log panel. */
const LOG_TONE: Record<string, string> = {
  error: "text-[#f2a07b]",
  played: "text-[#7fd6a4]",
  swept: "text-[#7fd6a4]",
  sent: "text-[#8fb8ff]",
  start: "text-[#e6eadf]",
  stop: "text-[#e6eadf]",
};
const LOG_MARK: Record<string, string> = { error: "!", played: "✓", swept: "✓", sent: "→", start: "▶", stop: "■" };

function ActivityLog({ account, client, running }: { account: string; client: HostedAgentsClient; running: boolean }) {
  const [items, setItems] = useState<AgentActivity[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => client.activity(account).then((list) => live && setItems(list)).catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), ACTIVITY_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [account, client]);
  return (
    <section aria-label="Agent activity log" aria-live="polite" className="overflow-hidden rounded-xl border border-[#2b3338] bg-[#161b1e] text-[#d8dfd3] shadow-inner">
      <header className="flex items-center justify-between border-b border-[#2b3338] bg-[#1d2327] px-3 py-2">
        <span className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.14em] text-[#9fb0a8]">
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${running ? "animate-pulse bg-[#7fd6a4]" : "bg-[#5b666c]"}`} />
          ACTIVITY LOG
        </span>
        <span className="text-[10px] text-[#6d7a80]">{running ? "live" : "paused"}{items ? ` · ${items.length} events` : ""}</span>
      </header>
      <div className="h-56 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5">
        {items === null ? (
          <p className="text-[#6d7a80]">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-[#6d7a80]">No activity yet. Press Start and the agent&apos;s moves will show up here.</p>
        ) : (
          <ul className="space-y-0.5">
            {items.map((a, i) => (
              <li key={`${a.at}:${i}`} className="grid grid-cols-[4.2rem_0.9rem_1fr] gap-x-2">
                <span className="text-[#6d7a80]">{new Date(a.at).toLocaleTimeString([], { hour12: false })}</span>
                <span aria-hidden="true" className={LOG_TONE[a.event] ?? "text-[#6d7a80]"}>{LOG_MARK[a.event] ?? "·"}</span>
                <span className={LOG_TONE[a.event] ?? "text-[#8a9499]"}>
                  {describeActivity(a)}
                  {a.txHash && (
                    <a
                      className="ml-2 text-[#8fb8ff] underline underline-offset-2"
                      href={`${config.explorerUrl}/txns/${encodeURIComponent(a.txHash)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={a.txHash}
                      aria-label={`View transaction ${a.txHash} in explorer`}
                    >
                      tx ↗
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function AgentRow({ agent, name, namespace, client, onChange }: { agent: HostedAgentView; name: string; namespace: Namespace; client: HostedAgentsClient; onChange: () => void }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await readAgentStatus(config.rpcUrl, namespace.arenaContract, agent.account));
    } catch {
      // The chain read is a convenience; the service state above is authoritative for running or stopped.
    }
  }, [agent.account, namespace.arenaContract]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChange();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const funded = !!status?.nearYocto;
  return (
    <Card className="space-y-3" aria-label={name}>
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm">{name}</strong>
        <Badge tone={agent.running ? "green" : "mute"}>{agent.running ? "running" : "stopped"}</Badge>
        <Badge tone={funded ? "green" : "amber"}>{funded ? "funded" : "not funded yet"}</Badge>
        <span className="text-xs text-mute">{STRATEGY_OPTIONS.find((o) => o.value === agent.style)?.title ?? agent.style}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {agent.running ? (
          <Button size="sm" variant="ghost" className="min-w-20" disabled={busy} onClick={() => void run(() => client.stop(agent.account))}>Stop</Button>
        ) : (
          <Button size="sm" className="min-w-20" disabled={busy} onClick={() => void run(() => client.start(agent.account))}>Start</Button>
        )}
      </div>
      {agent.lastError && <p role="alert" className="text-xs text-neon-amber">Stopped: {agent.lastError}</p>}
      {error && <p role="alert" className="text-xs text-neon-amber">{error}</p>}
      {secret && (
        <p role="alert" className="break-all rounded-lg border border-edge p-3 text-xs">
          {secret}
          <span className="mt-2 block text-neon-amber">Anyone with this key controls the agent&apos;s funds. Copy it now; this export is recorded.</span>
          <Button size="sm" variant="ghost" onClick={() => setSecret(null)}>Hide</Button>
        </p>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Fund it from your wallet</h3>
        <FundAgent account={agent.account} tokens={status?.tokens ?? []} onSent={() => void refresh()} />
      </section>

      <ActivityLog account={agent.account} client={client} running={agent.running} />

      <section className="space-y-1" aria-live="polite">
        <h3 className="text-sm font-semibold">Status</h3>
        <p className="text-sm">NEAR: {status?.nearYocto ? formatUnits(BigInt(status.nearYocto), 24, 4) : "0"}</p>
        <ul className="space-y-1 text-sm">
          {(status?.tokens ?? []).filter((t) => t.base !== "0").map((t) => (
            <li key={t.representation}>{symbolOf(t.representation)}: {formatUnits(BigInt(t.base), 18, 2)}</li>
          ))}
        </ul>
        <h4 className="text-xs font-semibold text-mute">Recent plays</h4>
        {(status?.plays.length ?? 0) === 0 ? (
          <p className="text-xs text-mute">No deposits in the latest battles yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {status!.plays.map((p) => (
              <li key={`${p.battleId}:${p.community}`}>Battle #{p.battleId}: {formatUnits(BigInt(p.amount), 18, 2)} {symbolOf(p.representation)}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-mute">Winnings are paid out on Robinhood Chain; see Portfolio.</p>
      </section>

      <details className="lifecycle-tech">
        <summary>Advanced</summary>
        <div className="mt-3 space-y-2">
          <p className="break-all text-xs text-mute">Agent account: {agent.account}</p>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => setSecret((await client.exportKey(agent.account)).secretKey))}>Export key</Button>
        </div>
      </details>
    </Card>
  );
}

/**
 * Hosted testnet agents: the platform holds the agent key and runs the agent, so the owner only creates, funds, starts and
 * stops it (OpenSpec `hosted-player-agents`). The wallet signs a challenge once to prove ownership.
 */
export function HostedAgent({ namespace }: { namespace: Namespace }) {
  const { accountId, loading, signIn } = useWallet();
  const getWallet = useActionWallet();
  const client = getHostedClient(config.hostedAgentsUrl);
  // Starts false so server and client markup match. After a reload the service says whether the cookie is still a
  // valid session for the connected wallet; if so the owner is not asked to sign again.
  const [signed, setSigned] = useState(false);
  useEffect(() => {
    if (loading || !accountId) return;
    let live = true;
    void client.checkSession().then((owner) => {
      if (live && owner === accountId) setSigned(true);
    });
    return () => {
      live = false;
    };
  }, [client, accountId, loading]);
  const [agents, setAgents] = useState<HostedAgentView[]>([]);
  const [style, setStyle] = useState<AgentStrategy>("underdog");
  const [sweep, setSweep] = useState(false);
  const [keepWhole, setKeepWhole] = useState("100");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAgents(await client.list());
    } catch (e) {
      setError(message(e));
      setSigned(client.signedIn);
    }
  }, [client]);
  useEffect(() => {
    if (!signed) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [signed, load]);
  // A different wallet (or a disconnected one) is a different owner: drop the session. While the wallet is still
  // loading nothing is dropped, and coming back to this page with the same wallet keeps the session.
  useEffect(() => {
    if (loading || client.owner === null || client.owner === accountId) return;
    void client.signOut();
    setSigned(false);
    setAgents([]);
  }, [accountId, loading, client]);

  const guarded = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const signInWithWallet = () =>
    guarded(async () => {
      if (!accountId || !getWallet) return signIn();
      await client.signIn(await getWallet(), accountId);
      setSigned(true);
    });
  const keep = Number(keepWhole);

  return (
    <div className="space-y-4">
      <Card role="note" className="space-y-1 border-neon-amber/60">
        <CardTitle>Testnet only</CardTitle>
        <p className="text-sm text-mute">
          Use only test tokens. We run the agent for you, you can stop it any time, and the most it can lose is what you send it.
        </p>
      </Card>

      {!signed ? (
        <Card className="space-y-3">
          <CardTitle>Agent that plays for you</CardTitle>
          <p className="text-sm text-mute">
            Create an agent, send it some testnet tokens and press Start. NEAR AI picks where to play and how much, with no approval step.
          </p>
          <Button disabled={busy} onClick={() => void signInWithWallet()}>{accountId ? "Sign in with your wallet" : "Connect wallet"}</Button>
          {error && <p role="alert" className="text-xs text-neon-amber">{error}</p>}
        </Card>
      ) : (
        <>
          <Card className="space-y-3">
            <CardTitle>Create an agent</CardTitle>
            <Select<AgentStrategy> label="Play style" value={style} options={STRATEGY_OPTIONS} onChange={setStyle} disabled={busy} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={sweep} onChange={(e) => setSweep(e.target.checked)} />
              Send surplus tokens back to my wallet ({accountId})
            </label>
            {sweep && (
              <div>
                <Label htmlFor="hosted-keep">Whole tokens to keep per token</Label>
                <Input id="hosted-keep" inputMode="numeric" value={keepWhole} onChange={(e) => setKeepWhole(e.target.value)} />
              </div>
            )}
            <Button
              disabled={busy || (sweep && !(Number.isInteger(keep) && keep >= 0))}
              onClick={() => void guarded(async () => { await client.create({ style, sweep, keepWhole: sweep ? keep : 0 }); await load(); })}
            >
              Create agent
            </Button>
            {error && <p role="alert" className="text-xs text-neon-amber">{error}</p>}
          </Card>
          {agents.length === 0 ? (
            <p className="text-sm text-mute">No agents yet.</p>
          ) : (
            agents.map((a, i) => <AgentRow key={a.account} agent={a} name={`Agent ${i + 1}`} namespace={namespace} client={client} onChange={() => void load()} />)
          )}
        </>
      )}
    </div>
  );
}
