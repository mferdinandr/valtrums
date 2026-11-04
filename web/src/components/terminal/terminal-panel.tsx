"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { FundingSource } from "@/components/terminal/funding-source";
import { useTerminalEnv, useWallet } from "@/components/providers";
import { useTerminal } from "@/hooks/use-terminal";
import { formatUsdc } from "@/lib/amounts";
import { MAX_PROMPT_CHARS } from "@/lib/terminal/intent";
import { canKeyDeposit } from "@/lib/terminal/session-key";
import type { Summary } from "@/lib/terminal/summary";
import type { FundingQuote } from "@/lib/terminal/funding";
import { cn } from "@/lib/utils";

const EXAMPLES = ["Deposit 50 USDC to $FLOKI", "All-in $FLOKI with my remaining 35 USDC credit and add 15 USDC from my Base wallet", "Setor 20 USDC ke $FLOKI"];

const LINE_TONE = { input: "text-neon-green", info: "text-mute", error: "text-neon-red", success: "text-neon-green" } as const;

function SummaryView({ summary }: { summary: Summary }) {
  return (
    <div>
      <h4 className="mb-2 font-pixel text-[10px] text-neon-amber">{summary.title}</h4>
      <dl className="space-y-1 text-xl">
        {summary.lines.map((l) => (
          <div key={l.label} className="flex flex-col gap-0 sm:flex-row sm:gap-4">
            <dt className="w-44 shrink-0 text-mute">{l.label}</dt>
            <dd className="break-words">{l.value}</dd>
          </div>
        ))}
      </dl>
      {summary.notes.map((n) => (
        <p key={n} className="mt-2 text-lg text-neon-amber">
          Note: {n}
        </p>
      ))}
    </div>
  );
}

function QuoteView({ quote }: { quote: FundingQuote }) {
  return (
    <div className="border-2 border-edge p-2 text-xl">
      <p>
        Bridge from <span className="text-neon-cyan">{quote.chain}</span>: send {formatUsdc(quote.amountIn, 6)}, receive at least{" "}
        {formatUsdc(quote.minAmountOut, 6)} on NEAR.
      </p>
      <p className="text-mute">
        Fee {formatUsdc(quote.feeUnits, 6)}, about {quote.etaSecs}s, valid until {new Date(quote.expiresAtMs).toLocaleTimeString()}.
      </p>
    </div>
  );
}

/** Command-line style prompt box. `scopeBattleId` limits prompts to one battle (battle detail page). */
export function TerminalPanel({ scopeBattleId, onDone }: { scopeBattleId?: number; onDone?: () => void }) {
  const { accountId, signIn } = useWallet();
  const { controller, state, history } = useTerminal(scopeBattleId);
  const env = useTerminalEnv();
  const [text, setText] = useState("");
  const [refunds, setRefunds] = useState<Record<string, string>>({});

  const busy = state.phase === "parsing" || state.phase === "quoting" || state.phase === "executing";
  const blockedInput = busy || state.phase === "confirm" || state.phase === "funding_confirm";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = text;
    setText("");
    await controller.submit(value);
  };

  const done = state.phase === "done";
  const [notified, setNotified] = useState(false);
  if (done && !notified) {
    setNotified(true);
    onDone?.();
  }
  if (!done && notified) setNotified(false);

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle className="mb-0">Intent terminal{scopeBattleId !== undefined ? ` (battle #${scopeBattleId})` : ""}</CardTitle>
        <Badge tone="cyan">Nothing runs until you confirm</Badge>
      </div>

      <div role="log" aria-live="polite" className="max-h-56 min-h-16 overflow-y-auto border-2 border-edge bg-black/60 p-3 font-term text-xl">
        {history.length === 0 ? (
          <p className="text-mute">Type a command, e.g. {EXAMPLES[0]}</p>
        ) : (
          history.map((h) => (
            <p key={h.id} className={cn("break-words", LINE_TONE[h.kind])}>
              {h.kind === "input" ? "> " : ""}
              {h.text}
            </p>
          ))
        )}
      </div>

      <form onSubmit={(e) => void submit(e)} className="flex gap-2">
        <label htmlFor="terminal-prompt" className="sr-only">
          Command
        </label>
        <span aria-hidden className="self-center font-pixel text-xs text-neon-green">
          &gt;
        </span>
        <Input
          id="terminal-prompt"
          value={text}
          maxLength={MAX_PROMPT_CHARS}
          onChange={(e) => setText(e.target.value)}
          placeholder={state.phase === "clarify" ? state.question : EXAMPLES[0]}
          disabled={blockedInput}
          autoComplete="off"
          spellCheck={false}
        />
        {accountId ? (
          <Button type="submit" disabled={blockedInput || text.trim() === ""}>
            Run
          </Button>
        ) : (
          <Button type="button" variant="cyan" onClick={() => void signIn()}>
            Connect
          </Button>
        )}
      </form>

      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            disabled={blockedInput}
            onClick={() => setText(ex)}
            className="max-w-full truncate border border-edge px-2 py-1 text-base text-mute hover:border-ink hover:text-ink disabled:opacity-40"
          >
            {ex}
          </button>
        ))}
      </div>

      {state.phase === "parsing" && <p className="blink font-pixel text-[10px] text-mute">READING...</p>}

      {state.phase === "clarify" && (
        <p role="status" className="border-2 border-neon-amber p-3 text-xl text-neon-amber">
          {state.question}
        </p>
      )}

      {state.phase === "blocked" && (
        <div role="alert" className="border-2 border-neon-red p-3 text-xl text-neon-red">
          <p className="font-pixel text-[10px]">BLOCKED, NOTHING WAS SENT</p>
          <ul className="mt-2 list-disc pl-5">
            {state.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {state.phase === "error" && (
        <p role="alert" className="border-2 border-neon-red p-3 text-xl text-neon-red">
          {state.message}
        </p>
      )}

      {state.phase === "confirm" && (
        <div className="space-y-3 border-2 border-neon-amber p-3">
          <SummaryView summary={state.summary} />
          <FundingSource plan={state.plan} onSelect={(src) => void controller.setFundingSource(src)} />
          {state.plan.bridgeLegs.map((l) => (
            <div key={l.chain}>
              <Label htmlFor={`refund-${l.chain}`}>Your {l.chain} address for refunds</Label>
              <Input
                id={`refund-${l.chain}`}
                value={refunds[l.chain] ?? ""}
                onChange={(e) => setRefunds((r) => ({ ...r, [l.chain]: e.target.value }))}
                placeholder="0x..."
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          ))}
          <div className="flex gap-2">
            <Button onClick={() => void controller.confirm(refunds)}>{state.plan.bridgeLegs.length > 0 ? "Confirm and get quote" : "Confirm and sign"}</Button>
            <Button variant="ghost" onClick={() => controller.cancel()}>
              Cancel
            </Button>
          </div>
          <p className="text-lg text-mute">
            {state.plan.payFromBalance
              ? accountId && canKeyDeposit(env.session.get(accountId), env.chain.arenaId, Date.now())
                ? "Your session key signs this deposit, so there is no wallet prompt. "
                : "Your wallet asks for one approval; no deposit is attached. "
              : "Your wallet asks for one approval. "}
            The terminal never holds your funds or keys.
          </p>
        </div>
      )}

      {state.phase === "quoting" && <p className="blink font-pixel text-[10px] text-mute">REQUESTING QUOTE...</p>}

      {state.phase === "funding_confirm" && (
        <div className="space-y-3 border-2 border-neon-amber p-3">
          <SummaryView summary={state.summary} />
          {state.quotes.map((q) => (
            <QuoteView key={q.id} quote={q} />
          ))}
          <div className="flex gap-2">
            <Button onClick={() => void controller.confirmFunding()}>Confirm funding and deposit</Button>
            <Button variant="ghost" onClick={() => controller.cancel()}>
              Cancel
            </Button>
          </div>
          <p className="text-lg text-mute">If the transfer fails or does not arrive, no deposit is made.</p>
        </div>
      )}

      {state.phase === "executing" && (
        <div role="status" className="border-2 border-neon-cyan p-3 text-xl">
          <p className="blink font-pixel text-[10px] text-neon-cyan">{state.stage === "funding" ? "FUNDING..." : "WAITING FOR WALLET..."}</p>
          {state.depositAddress && (
            <p className="mt-2 break-all">
              Send {formatUsdc(state.depositAddress.amount, 6)} USDC on {state.depositAddress.chain} to{" "}
              <span className="text-neon-amber">{state.depositAddress.address}</span> from your own wallet. The deposit continues when it arrives.
            </p>
          )}
        </div>
      )}

      {state.phase === "done" && (
        <p role="status" className="border-2 border-neon-green p-3 text-xl text-neon-green">
          Deposit sent into battle {state.plan.battleLabel}. Approved via {state.result.via === "wallet" ? "your wallet" : "your session key"}.{" "}
          <Link href={`/battles/${state.plan.battleId}`} className="underline">
            Open battle
          </Link>
        </p>
      )}

      {state.phase === "failed" && (
        <p role="alert" className="border-2 border-neon-red p-3 text-xl text-neon-red">
          Stopped at {state.result.stage}. {state.result.reason} Nothing was deposited.
        </p>
      )}
    </Card>
  );
}
