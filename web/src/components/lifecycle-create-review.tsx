"use client";
import { TransactionLink } from "@/components/transaction-link";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { useLifecycleCreate } from "@/hooks/use-lifecycle-create";
import { useWallet } from "@/components/providers";
import { pickerCapacity, pickerSummary } from "@/lib/arena-read/picker-summary";
import { TokenChip, TokenPicker, assetSymbol, type RegistryAsset } from "@/components/token-picker";
import { CarnivalScene } from "@/components/carnival/scene";
import { applicationKey } from "@/lib/arena-read/application";
import {
  MODE_COPY,
  shortAccount,
} from "@/lib/arena-read/lifecycle-presentation";
import type { ApplicationPage, Namespace } from "@/lib/arena-read/application";
import {
  buildCreateReview,
  MAX_COMMUNITIES,
  MIN_COMMUNITIES,
  SCORING_MODES,
  toActionRequest,
  type AssetDraft,
} from "@/lib/arena-read/create-review";
import "@/components/lifecycle/lifecycle.css";

const empty = (): AssetDraft => ({
  chainId: "",
  tokenAddress: "",
  representation: "",
  custodyDomain: "",
  referenceChainId: "",
  referenceAddress: "",
});

/**
 * Review and, on a deployment that enables a wallet, signing of `create_lifecycle_battle`. The reviewed
 * arguments are compared with the service's canonical preview before any authorization is requested; the
 * session token is memory-only; a wallet rejection leaves the review intact for a retry.
 */
export function LifecycleCreateReview({ namespace }: { namespace: Namespace }) {
  const [mode, setMode] = useState<string>("PriceGain");
  const [assets, setAssets] = useState<AssetDraft[]>([]);
  const [copied, setCopied] = useState(false);
  const [available, setAvailable] = useState<number | null>(null);
  const review = buildCreateReview(namespace.arenaContract, assets, mode);
  const request = useMemo(() => toActionRequest(assets, mode), [assets, mode]);
  const { signIn } = useWallet();
  const create = useLifecycleCreate(
    request,
    review.ok ? review : null,
    applicationKey(namespace),
  );
  const set = (i: number, patch: Partial<AssetDraft>) => {
    setCopied(false);
    setAssets((all) => all.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  };
  const chosen = useMemo(() => new Set(assets.map((a) => `${a.chainId}:${a.tokenAddress.toLowerCase()}`)), [assets]);
  const add = (p: RegistryAsset) => {
    setCopied(false);
    setAssets((all) =>
      all.length >= MAX_COMMUNITIES || all.some((a) => a.chainId === p.chainId && a.tokenAddress.toLowerCase() === p.token.toLowerCase())
        ? all
        : [
            ...all,
            {
              ...empty(),
              chainId: p.chainId,
              tokenAddress: p.token,
              referenceChainId: p.referenceChainId,
              referenceAddress: p.referenceToken,
              label: assetSymbol(p),
            },
          ],
    );
  };
  const remove = (i: number) => {
    setCopied(false);
    setAssets((all) => all.filter((_, j) => j !== i));
  };
  // Hide "nothing picked yet" noise until at least one field has been touched.
  const touched = assets.some(
    (a) => a.tokenAddress || a.representation || a.custodyDomain,
  );
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
            Choose a challenge and invite at least two token communities. Review
            every detail before your wallet signs.
          </p>
          <div className="lifecycle-facts">
            <span>{available === null ? "Choose at least 2 communities" : `${MIN_COMMUNITIES}–${pickerCapacity(available, MAX_COMMUNITIES)} communities`}</span>
            <span>30-second rounds</span>
            <span>No proposal bond</span>
          </div>
        </div>
        <CarnivalScene
          mode="create"
          caption="A little assembly required · decorative workshop"
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
            {SCORING_MODES.map((m) => (
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
            Some challenges may not be able to run live yet.
          </p>
        </Card>

        <Card className="space-y-4">
          <CardTitle>02 / Choose your communities</CardTitle>
          <p className="text-xs text-mute">
            {pickerSummary(assets.length, available, MIN_COMMUNITIES, MAX_COMMUNITIES)}
          </p>
          <div className="token-chips" aria-label="Chosen communities">
            {assets.map((a, i) => (
              <TokenChip key={`${a.chainId}:${a.tokenAddress}`} symbol={a.label || shortAccount(a.tokenAddress)} onRemove={() => remove(i)} />
            ))}
            {assets.length === 0 && <span className="text-xs text-mute">Nothing chosen yet. Pick tokens below.</span>}
          </div>
          <TokenPicker
            namespace={namespace}
            chosen={chosen}
            full={assets.length >= pickerCapacity(available, MAX_COMMUNITIES)}
            onPick={add}
            onAvailable={setAvailable}
          />
          {assets.map((a, i) => (
            <details
              key={`${a.chainId}:${a.tokenAddress}`}
              className="lifecycle-tech"
              open={!a.representation || !a.custodyDomain}
            >
              <summary>Required token setup for {a.label || shortAccount(a.tokenAddress)} · advanced</summary>
              <p className="mb-3">
                The registry does not provide a trusted representation or custody domain yet. Use values from your
                deployment operator; they are never guessed from a token name.
              </p>
              <Label>
                Representation (NEAR account of the NEP-141 token)
                <Input
                  value={a.representation}
                  maxLength={64}
                  onChange={(e) => set(i, { representation: e.target.value.trim().toLowerCase() })}
                />
              </Label>
              <Label>
                Custody domain
                <Input value={a.custodyDomain} maxLength={64} onChange={(e) => set(i, { custodyDomain: e.target.value })} />
              </Label>
            </details>
          ))}
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
              Pick at least two assets and fill their representation and custody
              domain.
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
