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
import { CarnivalScene } from "@/components/carnival/scene";
import { MODE_COPY } from "@/lib/arena-read/lifecycle-presentation";
import type { Namespace } from "@/lib/arena-read/application";
import {
  buildCreateReview,
  SCORING_MODES,
  toActionRequest,
  type AssetDraft,
} from "@/lib/arena-read/create-review";
import { formatUnits, parseUnits } from "@/lib/amounts";
import { TOKEN_DECIMALS } from "@/lib/arena-read/balances";
import { firstDepositProblems } from "@/lib/arena-read/create-deposit";
import { localInputToMs, msToLocalInput, utc } from "@/lib/arena-read/open-arena";
import "@/components/lifecycle/lifecycle.css";

/** An open arena lists no community at creation (D34): communities join before the start time. */
const NO_ASSETS: readonly AssetDraft[] = [];
const DEFAULT_LEAD_MS = 15 * 60 * 1000;

/**
 * Review and, on a deployment that enables a wallet, signing of `create_lifecycle_battle`. The reviewed
 * arguments are compared with the service's canonical preview before any authorization is requested; the
 * session token is memory-only; a wallet rejection leaves the review intact for a retry.
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
  const review = buildCreateReview(namespace.arenaContract, NO_ASSETS, mode, startAtMs, now, config.createModes);
  const request = useMemo(() => toActionRequest(NO_ASSETS, mode, startAtMs), [mode, startAtMs]);
  const { signIn } = useWallet();
  const run = useCreateAndDeposit({
    arena: namespace.arenaContract,
    createRequest: request,
    createReview: review.ok ? review : null,
    representation: token,
    label: chosen?.symbol ?? "",
    amount: amountBase,
  });
  const router = useRouter();
  // The battle and the first deposit are done: show the battle, where the creator's position is listed.
  useEffect(() => {
    if (run.state.step === "done") router.push(`/arena/${run.state.battleId}`);
  }, [run.state, router]);
  const touched = now > 0 && startInput !== "";
  return (
    <div className="lifecycle-page">
      <Link href="/arena" className="text-xs text-neon-green">
        ← Back to battles
      </Link>
      <section className="lifecycle-hero">
        <div>
          <span className="lifecycle-pill">THE RIVALRY WORKSHOP</span>
          <h1>
            Bring your crews.
            <br />
            Make a little rivalry.
          </h1>
          <p className="text-sm text-mute">
            Choose a challenge and a start time. Any approved token community
            can join until the start. Review every detail before your wallet
            signs.
          </p>
          <div className="lifecycle-facts">
            <span>Open to approved tokens</span>
            <span>30-second rounds</span>
            <span>No proposal bond</span>
          </div>
        </div>
        <CarnivalScene
          mode="create"
          caption="A little assembly required"
        />
      </section>

      <fieldset
        disabled={run.state.step === "running"}
        className="space-y-6 min-w-0"
      >
        <Card>
          <CardTitle>01 / Choose your challenge</CardTitle>
          <div
            className="lifecycle-mode-grid"
            role="group"
            aria-label="Scoring mode"
          >
            {SCORING_MODES.map((m) => {
              return (
                <button
                  key={m}
                  className="lifecycle-mode"
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() => {
                    setMode(m);
                  }}
                >
                  <strong>{MODE_COPY[m].name}</strong>
                  <span>{MODE_COPY[m].description}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-mute">
            Pick the challenge your battle is scored by.
          </p>
        </Card>

        <Card className="space-y-4">
          <CardTitle>02 / Set the start time</CardTitle>
          <Label>
            Start time (your local time)
            <Input
              type="datetime-local"
              value={startInput}
              onChange={(e) => {
                setStartInput(e.target.value);
              }}
              aria-describedby="start-help"
            />
          </Label>
          <p id="start-help" className="text-xs leading-6 text-mute">
            {startAtMs ? `Starts ${utc(Number(startAtMs))}. ` : ""}
            Between 1 minute and 7 days from now. Until then any approved token
            community can join and deposit. You must deposit in one community
            before the start. At the start the battle needs at least two funded
            communities; otherwise anyone can cancel it and every depositor
            claims a refund.
          </p>
        </Card>
        <Card className="space-y-4">
          <CardTitle>03 / Your first deposit</CardTitle>
          <p className="text-xs leading-6 text-mute">
            A battle needs a deposit from its creator before it can lock. After you sign the create transaction, you
            join with this token and deposit it right away.
          </p>
          {owned.length === 0 ? (
            <p role="status" className="text-xs text-neon-amber">
              {balances === null || joinable.items === null
                ? "Reading your tokens…"
                : "You hold no token this arena accepts. Claim some from the faucet first."}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Token to deposit">
              {owned.map((t) => (
                <button
                  key={t.token}
                  type="button"
                  className="lifecycle-mode"
                  aria-pressed={token === t.token}
                  onClick={() => setToken(t.token)}
                >
                  <strong>{t.symbol}</strong>
                  <span>Balance {formatUnits(BigInt(t.balance), TOKEN_DECIMALS, 4)}</span>
                </button>
              ))}
            </div>
          )}
          <Label>
            Amount to deposit
            <Input
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value.trim())}
            />
          </Label>
        </Card>
      </fieldset>

      <Card aria-label="Transaction review">
        <CardTitle>04 / Review before you sign</CardTitle>
        {!review.ok ? (
          touched ? (
            <ul
              role="status"
              className="list-disc pl-4 text-sm text-neon-amber"
            >
              {review.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-mute">
              Choose a challenge and a start time.
            </p>
          )
        ) : (
          <>
            <ul className="space-y-1 text-sm">
              <li>
                <span className="text-mute">Challenge: </span>
                {MODE_COPY[mode as keyof typeof MODE_COPY]?.name ?? mode}
              </li>
              <li>
                <span className="text-mute">Starts: </span>
                {startAtMs ? utc(Number(startAtMs)) : "-"}
              </li>
              <li>
                <span className="text-mute">Your first deposit: </span>
                {chosen && amountBase
                  ? `${formatUnits(BigInt(amountBase), TOKEN_DECIMALS, 4)} ${chosen.symbol}`
                  : "choose a token and an amount above"}
              </li>
            </ul>
            <p className="mt-3 text-xs leading-6 text-mute">
              Your wallet asks you to confirm three times: create the battle,
              join with your token, then deposit it. A small network fee is
              charged and the unused part is refunded.
            </p>
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
              <pre
                className="mt-3 max-h-64 overflow-auto rounded-lg border border-edge p-3 text-xs"
                aria-label="Exact arguments"
              >
                {JSON.stringify(review.args, null, 2)}
              </pre>
            </details>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {run.connected ? (
                <Button
                  type="button"
                  onClick={run.run}
                  disabled={depositProblems.length > 0 || run.state.step === "running" || run.state.step === "done"}
                >
                  {run.state.step === "failed"
                    ? "Continue"
                    : chosen && amountBase
                      ? `Create battle & deposit ${formatUnits(BigInt(amountBase), TOKEN_DECIMALS, 4)} ${chosen.symbol}`
                      : "Create battle & deposit"}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void signIn()}
                >
                  Connect wallet to continue
                </Button>
              )}
            </div>
            {depositProblems.length > 0 && (
              <ul role="status" className="mt-2 list-disc pl-4 text-xs text-neon-amber">
                {depositProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            {!run.connected && (
              <p className="mt-2 text-xs text-mute">
                Connect your wallet to create the battle.
              </p>
            )}
            {run.state.step === "running" && (
              <p role="status" className="mt-3 text-xs text-mute">
                {run.state.waitingForAudit ? "Step 3 of 3: waiting for the community's audit approval. This can take a minute." : `${STAGE_TEXT[run.state.stage]} Confirm in your wallet when asked.`}
              </p>
            )}
            {run.state.step === "failed" && (
              <div role="alert" className="mt-3 space-y-1 text-xs text-neon-amber">
                <p>{STAGE_NAME[run.state.stage]} failed: {run.state.message}</p>
                <p>
                  {run.state.battleId !== null
                    ? `Your battle #${run.state.battleId} already exists. Press Continue to finish the remaining steps, or `
                    : "Nothing was created. Press Continue to try again, or "}
                  {run.state.battleId !== null ? (
                    <Link href={`/arena/${run.state.battleId}`} className="underline">open the battle</Link>
                  ) : (
                    "change your choices above."
                  )}
                </p>
              </div>
            )}
            {run.state.step === "done" && (
              <p role="status" className="mt-3 text-xs text-neon-green">
                Done. Opening your battle…
              </p>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
