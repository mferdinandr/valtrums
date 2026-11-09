"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowUpRight,
  RotateCcw,
  ShieldCheck,
  Swords,
  Check,
} from "lucide-react";
import { KineticScene } from "./scene";
import { Button } from "@/components/ui/button";
import type { Side } from "@/lib/arena/types";

type Step = "choose" | "loaded" | "live" | "result";
const LENGTH = 6000;
const STEPS = [
  {
    number: "01",
    title: "Back your community.",
    text: "Choose a battle, inspect both tokens and deposit into one side while its deposit window is open. Your deposited coins are at risk if your side loses.",
  },
  {
    number: "02",
    title: "Let the rivalry play out.",
    text: "Deposits close before the battle runs. The current app compares price performance between two communities. Inspect its recorded timing, available performance and settlement steps.",
  },
  {
    number: "03",
    title: "Claim. Then withdraw.",
    text: "If your side wins, claim into your arena liquid balance, then withdraw to your wallet. Locked credit is separate from withdrawable tokens.",
  },
];

export function Landing() {
  const [side, setSide] = useState<Side>("A");
  const [step, setStep] = useState<Step>("choose");
  const [remaining, setRemaining] = useState(LENGTH);
  const stepPanel = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    const next =
      stepPanel.current?.querySelector<HTMLElement>("button, a") ??
      stepPanel.current;
    next?.focus({ preventScroll: true });
  }, [step]);
  useEffect(() => {
    if (step !== "live") return;
    const end = Date.now() + LENGTH;
    const timer = window.setInterval(() => {
      const left = Math.max(0, end - Date.now());
      setRemaining(left);
      if (left === 0) {
        window.clearInterval(timer);
        moveFocus.current = !!stepPanel.current?.contains(
          document.activeElement,
        );
        setStep("result");
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [step]);
  const reset = () => {
    setStep("choose");
    setRemaining(LENGTH);
  };
  return (
    <div className="landing-page">
      <section className="relative grid items-center gap-4 pb-12 pt-5 lg:grid-cols-[.9fr_1.1fr] lg:pb-20 lg:pt-10">
        <div className="relative z-10 max-w-xl">
          <p className="eyebrow flex items-center gap-2 text-neon-green">
            <span className="status-dot" /> Token communities. Mechanical
            rivalry.
          </p>
          <h1 className="mt-7 font-pixel text-[clamp(3.8rem,8.5vw,8rem)] font-medium leading-[.9] tracking-[-.075em]">
            Your tribe.
            <br />
            <span className="text-neon-green">Their liquidity.</span>
          </h1>
          <p className="mt-7 max-w-sm text-sm leading-7 text-mute">
            A battleground for token communities. Choose a side, back it with
            your coins, and follow the outcome inside a living mechanical arena.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/arena">
                Enter Arena <ArrowUpRight size={17} />
              </Link>
            </Button>
            <Button asChild variant="ghost" size="lg">
              <a href="#practice">
                Try without a wallet <ArrowDown size={15} />
              </a>
            </Button>
          </div>
          <p className="mt-5 text-[11px] leading-6 text-mute">
            Built on NEAR · Testnet experience
            <br />
            Explore first. Connect your wallet when you are ready.
          </p>
        </div>
        <div
          id="practice"
          className="relative min-w-0 scroll-mt-32 overflow-hidden rounded-2xl border border-edge bg-[#161f26]"
        >
          <div className="flex items-center justify-between gap-3 border-b border-edge px-5 py-4">
            <span className="eyebrow text-neon-amber">Practice chamber</span>
            <span className="font-mono text-[10px] text-mute">
              SIMULATION / NO FUNDS
            </span>
          </div>
          <KineticScene
            mode="battle"
            className="h-[340px] sm:h-[420px]"
            battle={{
              selected: side,
              onSelect: setSide,
              selectable: step === "choose",
              lockedSide: null,
              phase: step === "loaded" ? "preview" : "idle",
              status:
                step === "live"
                  ? "Live"
                  : step === "result"
                    ? "Settled"
                    : "Approved",
              winner: step === "result" ? "A" : null,
              symbols: ["LIME", "LILAC"],
              progress: 1 - remaining / LENGTH,
            }}
          />
          <div className="relative border-t border-edge bg-void/60 p-5">
            <div className="mb-4 flex gap-1.5" aria-hidden="true">
              {["choose", "loaded", "live", "result"].map((item, index) => (
                <span
                  key={item}
                  className={`h-1 flex-1 rounded-full transition-colors duration-300 ${index <= ["choose", "loaded", "live", "result"].indexOf(step) ? "bg-neon-green/80" : "bg-edge"}`}
                />
              ))}
            </div>
            <div className="mb-4 flex items-center justify-between">
              <span className="eyebrow">
                {step === "choose"
                  ? "01 / Choose your practice tribe"
                  : step === "loaded"
                    ? "02 / Preview the vault"
                    : step === "live"
                      ? "03 / Practice round running"
                      : "04 / Scripted result"}
              </span>
              <button
                onClick={reset}
                aria-label="Reset practice round"
                className="grid h-10 w-10 place-items-center rounded-full border border-edge text-mute hover:text-neon-green"
              >
                <RotateCcw size={14} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {(["A", "B"] as const).map((s) => (
                <button
                  key={s}
                  disabled={step !== "choose"}
                  onClick={() => setSide(s)}
                  aria-pressed={side === s}
                  className={`relative rounded-lg border px-4 py-3 text-left transition-colors duration-200 disabled:cursor-default ${side === s ? (s === "A" ? "border-neon-green/60 bg-neon-green/10" : "border-neon-pink/60 bg-neon-pink/10") : "border-edge enabled:hover:bg-white/5"}`}
                >
                  {side === s && (
                    <Check
                      size={14}
                      aria-hidden="true"
                      className={`absolute right-3 top-3 ${s === "A" ? "text-neon-green" : "text-neon-pink"}`}
                    />
                  )}
                  <span className="block font-pixel text-sm">
                    {s === "A" ? "LIME" : "LILAC"}
                  </span>
                  <span className="text-[10px] text-mute">
                    {side === s ? "Your practice tribe" : "Tribe " + s}
                  </span>
                </button>
              ))}
            </div>
            <div
              className="mt-4 min-h-[152px] sm:min-h-[132px]"
              aria-live="polite"
              aria-atomic="true"
            >
              <div
                ref={stepPanel}
                key={step}
                className="practice-step rounded-lg"
                tabIndex={-1}
                aria-label="Practice round controls"
              >
                {step === "choose" && (
                  <>
                    <p className="mb-3 text-xs leading-6 text-mute">
                      Click a 3D podium or choose a tribe above. Load
                      illustrative capsules to see how the vault responds.
                    </p>
                    <Button
                      onClick={() => {
                        moveFocus.current = true;
                        setStep("loaded");
                      }}
                    >
                      Load practice vault <ArrowUpRight size={14} />
                    </Button>
                  </>
                )}
                {step === "loaded" && (
                  <>
                    <p className="mb-3 text-xs leading-6 text-mute">
                      The lid opens and preview capsules orbit your vault. No
                      assets move. Ready to see a shortened practice round?
                    </p>
                    <Button
                      onClick={() => {
                        moveFocus.current = true;
                        setRemaining(LENGTH);
                        setStep("live");
                      }}
                    >
                      Start practice battle <Swords size={14} />
                    </Button>
                  </>
                )}
                {step === "live" && (
                  <div className="flex items-center justify-between py-3">
                    <p className="max-w-[220px] text-xs leading-6 text-mute">
                      Both vaults are locked. The ring tracks this scripted
                      practice interval.
                    </p>
                    <span
                      aria-hidden="true"
                      className="min-w-[3ch] text-right font-mono text-4xl tabular-nums text-neon-amber"
                    >
                      {Math.ceil(remaining / 1000)}s
                    </span>
                  </div>
                )}
                {step === "result" && (
                  <>
                    <p className="font-pixel text-lg text-neon-green">
                      LIME wins this practice round.
                    </p>
                    <p className="mt-2 text-xs leading-6 text-mute">
                      {side === "A"
                        ? "You chose the winning side. In an actual battle, inspect your claim in Portfolio."
                        : "You chose LILAC. In an actual battle, the losing side loses its deposited coins."}
                    </p>
                    <Link
                      href="/arena"
                      className="mt-3 inline-flex items-center gap-2 text-xs text-neon-green"
                    >
                      Explore actual battles <ArrowUpRight size={14} />
                    </Link>
                  </>
                )}
              </div>
            </div>
            <p className="mt-4 border-t border-edge pt-3 text-[10px] leading-5 text-mute">
              6-second scripted walkthrough. LIME always wins this demo.
              Fictional tokens, no wallet, no transactions and no live market
              data. Actual battles use their configured duration.
            </p>
          </div>
        </div>
      </section>
      <section
        id="mechanics"
        className="scroll-mt-32 border-t border-edge py-12 md:py-20"
      >
        <div className="mb-10 flex flex-wrap items-end justify-between gap-5">
          <div>
            <p className="eyebrow text-neon-green">
              The rules behind the rivalry
            </p>
            <h2 className="mt-4 text-3xl tracking-tight md:text-5xl">
              A game face.
              <br />
              An economy underneath.
            </h2>
          </div>
          <p className="max-w-sm text-sm leading-7 text-mute">
            The machine makes the action visible. The battle data determines
            what you can do and what you receive.
          </p>
        </div>
        <div className="grid md:grid-cols-3">
          {STEPS.map((item) => (
            <article
              key={item.number}
              className="border-t border-edge py-7 pr-6 md:border-r md:px-7 md:first:pl-0 md:last:border-r-0"
            >
              <span className="font-mono text-4xl text-neon-green/35">
                {item.number}
              </span>
              <h3 className="mt-5 text-xl">{item.title}</h3>
              <p className="mt-3 text-sm leading-7 text-mute">{item.text}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="overflow-hidden rounded-2xl border border-edge bg-panel p-6 md:p-10">
        <div className="grid gap-8 lg:grid-cols-[1fr_1.5fr]">
          <div>
            <p className="eyebrow text-neon-amber">Current app mechanics</p>
            <h2 className="mt-4 text-3xl">
              Where does the
              <br />
              losing vault go?
            </h2>
            <p className="mt-4 max-w-sm text-sm leading-7 text-mute">
              The current implementation sells the losing token into USDC and
              splits those proceeds. Winning principal is returned through the
              liquid balance.
            </p>
          </div>
          <div>
            <div
              className="mb-6 flex h-8 gap-1 overflow-hidden rounded-md"
              aria-hidden="true"
            >
              <span className="w-[55%] bg-neon-green" />
              <span className="w-[35%] bg-neon-cyan" />
              <span className="w-[5%] bg-neon-pink" />
              <span className="w-[5%] bg-neon-amber" />
            </div>
            <dl className="grid grid-cols-2 gap-6">
              {[
                {
                  value: "55%",
                  title: "Winner-token rewards",
                  text: "Buys liquid winner tokens.",
                  color: "text-neon-green",
                },
                {
                  value: "35%",
                  title: "Locked credit",
                  text: "Separate credit for future deposits.",
                  color: "text-neon-cyan",
                },
                {
                  value: "5%",
                  title: "Buy & burn",
                  text: "Buys and burns winner tokens.",
                  color: "text-neon-pink",
                },
                {
                  value: "5%",
                  title: "Protocol fee",
                  text: "Allocated to the protocol.",
                  color: "text-neon-amber",
                },
              ].map((item) => (
                <div key={item.title}>
                  <dt className={`font-mono text-3xl ${item.color}`}>
                    {item.value}
                  </dt>
                  <dd className="mt-2 font-pixel text-sm">{item.title}</dd>
                  <dd className="mt-1 text-xs leading-6 text-mute">
                    {item.text}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-5 text-[11px] leading-6 text-mute">
              Inspect the actual battle and settlement preview before
              depositing. Creating a battle requires the configured USDC
              proposal bond.
            </p>
          </div>
        </div>
      </section>
      <section className="relative my-14 overflow-hidden border-y border-edge py-12 md:my-20 md:py-16">
        <div className="pointer-events-none absolute -right-16 -top-28 h-96 w-96 rounded-full border-[40px] border-neon-green/5" />
        <div className="relative flex flex-wrap items-center justify-between gap-8">
          <div>
            <p className="eyebrow flex items-center gap-2">
              <ShieldCheck size={14} /> You have seen the mechanics
            </p>
            <h2 className="mt-4 text-4xl md:text-6xl">
              Choose your next rivalry.
            </h2>
            <p className="mt-4 text-sm text-mute">
              Browse battles without connecting. Enter with your eyes open.
            </p>
          </div>
          <Button asChild size="lg">
            <Link href="/arena">
              Enter Arena <ArrowUpRight size={18} />
            </Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
