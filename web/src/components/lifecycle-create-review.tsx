"use client";
import { TransactionLink } from "@/components/transaction-link";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { useLifecycleCreate } from "@/hooks/use-lifecycle-create";
import { useNow } from "@/hooks/use-now";
import { useWallet } from "@/components/providers";
import { config } from "@/lib/config";
import { CarnivalScene } from "@/components/carnival/scene";
import { applicationKey } from "@/lib/arena-read/application";
import { MODE_COPY } from "@/lib/arena-read/lifecycle-presentation";
import type { Namespace } from "@/lib/arena-read/application";
import {
  buildCreateReview,
  SCORING_MODES,
  toActionRequest,
  type AssetDraft,
} from "@/lib/arena-read/create-review";
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
  const [copied, setCopied] = useState(false);
  const now = useNow(1000);
  // Default start: 15 minutes from the first client clock read (the server render has no clock).
  useEffect(() => {
    if (now > 0 && startInput === "") setStartInput(msToLocalInput(now + DEFAULT_LEAD_MS));
  }, [now, startInput]);
  const startAtMs = localInputToMs(startInput);
  const review = buildCreateReview(namespace.arenaContract, NO_ASSETS, mode, startAtMs, now, config.createModes);
  const request = useMemo(() => toActionRequest(NO_ASSETS, mode, startAtMs), [mode, startAtMs]);
  const { signIn } = useWallet();
  const create = useLifecycleCreate(
    request,
    review.ok ? review : null,
    applicationKey(namespace),
  );
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
        disabled={create.flow.step === "signing"}
        className="space-y-6 min-w-0"
      >
        <Card>
          <CardTitle>01 / Choose your challenge</CardTitle>
          <div
            className="lifecycle-mode-grid"
            role="group"
            aria-label="Scoring mode"
          >
            {SCORING_MODES.filter((m) => config.createModes.includes(m)).map((m) => (
              <button
                key={m}
                className="lifecycle-mode"
                type="button"
                aria-pressed={mode === m}
                onClick={() => {
                  setMode(m);
                  setCopied(false);
                }}
              >
                <strong>{MODE_COPY[m].name}</strong>
                <span>{MODE_COPY[m].description}</span>
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-mute">
            Only the challenges this arena can run live are offered.
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
                setCopied(false);
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
      </fieldset>

      <Card aria-label="Transaction review">
        <CardTitle>03 / Review before you sign</CardTitle>
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
            <dl className="space-y-1 text-sm">
              {review.lines.map((l) => (
                <div
                  key={l.label}
                  className="flex flex-col gap-0 sm:flex-row sm:gap-4"
                >
                  <dt className="w-48 shrink-0 text-mute">{l.label}</dt>
                  <dd className="break-all">{l.value}</dd>
                </div>
              ))}
            </dl>
            {review.notes.map((n) => (
              <p key={n} className="mt-2 text-xs text-mute">
                {n}
              </p>
            ))}
            <details className="lifecycle-tech">
              <summary>Exact transaction arguments</summary>
              <pre
                className="mt-3 max-h-64 overflow-auto rounded-lg border border-edge p-3 text-xs"
                aria-label="Exact arguments"
              >
                {JSON.stringify(review.args, null, 2)}
              </pre>
            </details>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                variant="ghost"
                type="button"
                onClick={async () => {
                  await navigator.clipboard?.writeText(
                    JSON.stringify(review.args),
                  );
                  setCopied(true);
                }}
              >
                {copied ? "Copied" : "Copy exact arguments"}
              </Button>
              {create.connected ? (
                <Button
                  type="button"
                  onClick={create.preview}
                  disabled={
                    create.flow.step === "previewing" ||
                    create.flow.step === "signing"
                  }
                >
                  {create.flow.step === "previewing"
                    ? "Checking your review…"
                    : "Check transaction preview"}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void signIn()}
                >
                  Connect wallet to sign
                </Button>
              )}
            </div>
            {!create.connected && (
              <p className="mt-2 text-xs text-mute">
                Signing needs a connected wallet on a deployment that enables it
                (NEXT_PUBLIC_APPLICATION_WALLET). Without one this page stays
                review-only and nothing is sent.
              </p>
            )}
            {create.flow.step === "blocked" && (
              <ul
                role="alert"
                className="mt-3 list-disc pl-4 text-xs text-neon-red"
              >
                <li>
                  Stopped before any authorization: the service's preview is not
                  the call you reviewed.
                </li>
                {create.flow.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            {create.flow.step === "previewed" && (
              <div className="mt-3 space-y-2" role="status">
                <p className="text-xs text-neon-green">
                  Your request is ready to review in your wallet.
                  Nothing is signed yet.
                </p>
                <p className="break-all text-xs text-mute">
                  Preview {create.flow.previewed.record.previewHash}
                </p>
                <Button type="button" onClick={create.execute}>
                  Authorize and sign with wallet
                </Button>
                <p className="text-xs text-mute">
                  Your wallet will ask you to approve this exact preview, then
                  to sign the transaction.
                </p>
              </div>
            )}
            {create.flow.step === "signing" && (
              <p role="status" className="mt-3 text-xs text-mute">
                Waiting for the wallet and the verified receipt…
              </p>
            )}
            {create.flow.step === "done" && (
              <p
                role={create.flow.result.ok ? "status" : "alert"}
                className={
                  create.flow.result.ok
                    ? "mt-3 text-xs text-neon-green"
                    : "mt-3 text-xs text-neon-amber"
                }
              >
                {create.flow.result.ok
                  ? `Confirmed with a verified receipt. Transaction ${create.flow.result.txHash}.`
                  : `Not confirmed (${create.flow.result.status}): ${create.flow.result.reason}${create.flow.result.txHash ? ` Transaction ${create.flow.result.txHash} was submitted; it is not a created battle until the receipt is verified.` : ""}`}
                {create.flow.result.fixture
                  ? ` ${create.flow.result.fixture}`
                  : ""}
                <TransactionLink hash={create.flow.result.txHash} />
              </p>
            )}
            {create.flow.step === "error" && (
              <p role="alert" className="mt-3 text-xs text-neon-red">
                {create.flow.message}{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={create.reset}
                >
                  Try again
                </button>
              </p>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
