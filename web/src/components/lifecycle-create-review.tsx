"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { useBalances } from "@/hooks/use-balances";
import { useJoinableAssets } from "@/hooks/use-joinable-assets";
import { STAGE_NAME, STAGE_TEXT, useCreateAndDeposit } from "@/hooks/use-create-and-deposit";
import { useNow } from "@/hooks/use-now";
import { useWallet } from "@/components/providers";
import { config } from "@/lib/config";
import { MODE_COPY } from "@/lib/arena-read/lifecycle-presentation";
import type { Namespace } from "@/lib/arena-read/application";
import {
  buildCreatorDepositReview,
  creatorDepositRequest,
  SCORING_MODES,
} from "@/lib/arena-read/create-review";
import { formatUnits, parseUnits } from "@/lib/amounts";
import { TOKEN_DECIMALS } from "@/lib/arena-read/balances";
import { firstDepositProblems } from "@/lib/arena-read/create-deposit";
import { localInputToMs, msToLocalInput, utc } from "@/lib/arena-read/open-arena";
import "@/components/lifecycle/lifecycle.css";

const DEFAULT_LEAD_MS = 15 * 60 * 1000;

/**
 * Creates a battle with the creator's first deposit (D41) in one form. The reviewed arguments are compared with
 * the service's canonical preview before any authorization is requested; the session token is memory-only; a
 * wallet rejection leaves the form intact for a retry.
 */
export function LifecycleCreateReview({ namespace }: { namespace: Namespace }) {
  const [mode, setMode] = useState<string>(config.createModes[0] ?? "PriceGain");
  const [startInput, setStartInput] = useState("");
  const [token, setToken] = useState("");
  const [amount, setAmount] = useState("");
  const { balances } = useBalances();
  const joinable = useJoinableAssets(namespace.arenaContract);
  // Only tokens the creator holds and the arena lets anyone join with can back the first deposit.
  const owned = useMemo(
    () =>
      (balances?.tokens ?? []).filter(
        (t) => BigInt(t.balance) > 0n && (joinable.items ?? []).some((a) => a.representation === t.token),
      ),
    [balances, joinable.items],
  );
  const chosen = owned.find((t) => t.token === token) ?? null;
  // The creator types whole tokens ("100"); the chain and the review use base units.
  const amountBase = parseUnits(amount, TOKEN_DECIMALS)?.toString() ?? "";
  const depositProblems = firstDepositProblems(token, amountBase, chosen ? chosen.balance : null);
  const now = useNow(1000);
  // Default start: 15 minutes from the first client clock read (the server render has no clock).
  useEffect(() => {
    if (now > 0 && startInput === "") setStartInput(msToLocalInput(now + DEFAULT_LEAD_MS));
  }, [now, startInput]);
  const startAtMs = localInputToMs(startInput);
  const deposit = useMemo(
    () => ({ representation: token, amount: amountBase, label: chosen?.symbol }),
    [token, amountBase, chosen?.symbol],
  );
  const review = buildCreatorDepositReview(namespace.arenaContract, deposit, mode, startAtMs, now, config.createModes);
  const request = useMemo(() => creatorDepositRequest(deposit, mode, startAtMs), [deposit, mode, startAtMs]);
  const { signIn } = useWallet();
  const run = useCreateAndDeposit({
    arena: namespace.arenaContract,
    createRequest: request,
    createReview: review.ok ? review : null,
  });
  const router = useRouter();
  // The battle exists with the creator's deposit in escrow: show it, where the creator's position is listed.
  useEffect(() => {
    if (run.state.step === "done") router.push(`/arena/${run.state.battleId}`);
  }, [run.state, router]);
  const touched = now > 0 && startInput !== "";
  const label = chosen && amountBase ? `${formatUnits(BigInt(amountBase), TOKEN_DECIMALS, 4)} ${chosen.symbol}` : null;
  const problems = [...(review.ok ? [] : touched ? review.problems : []), ...depositProblems.filter((p) => touched && !(review.ok ? [] : review.problems).includes(p))];
  return (
    <div className="lifecycle-page">
      <Link href="/arena" className="text-xs text-neon-green">
        ← Back to battles
      </Link>
      <section>
        <h1 className="text-2xl">Create a battle</h1>
        <p className="mt-2 text-sm text-mute">
          Pick a challenge, a start time and the first token you deposit. Anyone can join until it starts.
        </p>
      </section>

      <Card aria-label="Transaction review" className="space-y-6">
        <fieldset disabled={run.state.step === "running"} className="min-w-0 space-y-6">
          <div className="space-y-2">
            <CardTitle>Challenge</CardTitle>
            <div className="lifecycle-mode-grid" role="group" aria-label="Scoring mode">
              {SCORING_MODES.map((m) => (
                <button key={m} className="lifecycle-mode" type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
                  <strong>{MODE_COPY[m].name}</strong>
                  <span>{MODE_COPY[m].description}</span>
                </button>
              ))}
            </div>
          </div>

          <Label>
            Start time (your local time)
            <Input type="datetime-local" value={startInput} onChange={(e) => setStartInput(e.target.value)} aria-describedby="start-help" />
          </Label>
          <p id="start-help" className="-mt-4 text-xs text-mute">
            {startAtMs ? `Starts ${utc(Number(startAtMs))}. ` : ""}1 minute to 7 days from now.
          </p>

          <div className="space-y-2">
            <CardTitle>Your deposit</CardTitle>
            {owned.length === 0 ? (
              <p role="status" className="text-xs text-neon-amber">
                {balances === null || joinable.items === null
                  ? "Reading your tokens…"
                  : "You hold no token this arena accepts. Claim some from the faucet first."}
              </p>
            ) : (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Token to deposit">
                {owned.map((t) => (
                  <button key={t.token} type="button" className="lifecycle-mode" aria-pressed={token === t.token} onClick={() => setToken(t.token)}>
                    <strong>{t.symbol}</strong>
                    <span>Balance {formatUnits(BigInt(t.balance), TOKEN_DECIMALS, 4)}</span>
                  </button>
                ))}
              </div>
            )}
            <Label>
              Amount
              <Input inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value.trim())} />
            </Label>
            <p className="text-xs text-mute">
              Your deposit creates the battle. It is held in escrow until the token is approved, then becomes your position.
              First battle: a one-time 0.05 NEAR prepayment for storage (withdrawable, not a bond).
            </p>
          </div>
        </fieldset>

        {problems.length > 0 && (
          <ul role="status" className="list-disc pl-4 text-sm text-neon-amber">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {run.connected ? (
            <Button
              type="button"
              onClick={run.run}
              disabled={!review.ok || depositProblems.length > 0 || run.state.step === "running" || run.state.step === "done"}
            >
              {run.state.step === "failed" ? "Continue" : label ? `Create battle & deposit ${label}` : "Create battle & deposit"}
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={() => void signIn()}>
              Connect wallet to continue
            </Button>
          )}
        </div>
        {run.state.step === "running" && (
          <p role="status" className="text-xs text-mute">
            {STAGE_TEXT[run.state.stage]} Confirm in your wallet when asked.
          </p>
        )}
        {run.state.step === "failed" && (
          <p role="alert" className="text-xs text-neon-amber">
            {STAGE_NAME[run.state.stage]} failed: {run.state.message} Press Continue to try again.
          </p>
        )}
        {run.state.step === "done" && (
          <p role="status" className="text-xs text-neon-green">
            Done. Opening your battle…
          </p>
        )}

        {review.ok && (
          <details className="lifecycle-tech">
            <summary>Technical details</summary>
            <dl className="mt-3 space-y-1 text-xs">
              {review.lines.map((l) => (
                <div key={l.label} className="flex flex-col gap-0 sm:flex-row sm:gap-4">
                  <dt className="w-48 shrink-0 text-mute">{l.label}</dt>
                  <dd className="break-all">{l.value}</dd>
                </div>
              ))}
            </dl>
            <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-edge p-3 text-xs" aria-label="Exact arguments">
              {JSON.stringify(review.args, null, 2)}
            </pre>
          </details>
        )}
      </Card>
    </div>
  );
}
