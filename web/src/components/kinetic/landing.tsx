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
import dynamic from "next/dynamic";
import { TargetFlow } from "@/components/target-flow";
import { MemeMechanics } from "@/components/meme-mechanics";

const PracticeScene = dynamic(() => import("./practice-scene"), { ssr: false, loading: () => <div className="scene-floor h-[340px] sm:h-[420px]" /> });
const PRACTICE_TOKENS = ["CASHCAT", "BTCETHUSDT", "REBATE", "OAK", "WIF"] as const;
import { Button } from "@/components/ui/button";


type Step = "choose" | "loaded" | "live" | "result";
const LENGTH = 30000;
const STEPS = [
  { number: "01", title: "Choose a community.", text: "Discover a battle with two or more communities. Check the scoring mode and audit status before joining." },
  { number: "02", title: "Play the round.", text: "Deposits lock before a 30-second round. Tied leaders advance to another round while all vaults remain locked." },
  { number: "03", title: "Follow the outcome.", text: "Winning players receive losing-token entitlements. Winning principal stays in DAO escrow for a burn or return decision." },
];

export function Landing() {
  const [side, setSide] = useState(0);
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
      <section className="landing-hero relative grid items-center gap-8 pb-12 pt-5 lg:grid-cols-[.9fr_1.1fr] lg:pb-20 lg:pt-10">
        <div className="relative z-10 max-w-xl">
          <p className="landing-kicker"><span className="status-dot" /> THE COMMUNITY BATTLEGROUND <span className="landing-kicker-tag">NEAR TESTNET</span></p>
          <h1 className="landing-title mt-7 font-pixel text-[clamp(3.8rem,7.5vw,7rem)] font-bold leading-[.9] tracking-[-.075em]">
            PICK A SIDE.
            <br />
            <span className="text-neon-green">OWN THE ARENA.</span>
          </h1>
          <p className="mt-7 max-w-sm text-sm leading-7 text-mute">
            Multiple communities enter. One side comes out on top. Back your tribe, follow the battle, and see where the rivalry takes you.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/arena">
                Enter the arena <ArrowUpRight size={17} />
              </Link>
            </Button>
            <Button asChild variant="ghost" size="lg">
              <a href="#practice">
                Try without a wallet <ArrowDown size={15} />
              </a>
            </Button>
          </div>
          <p className="mt-5 text-xs leading-6 text-neon-amber">Five-tribe practice illustrates the planned experience. Current battles support two communities.</p>
          <div className="landing-brief"><span><strong>01</strong> PICK YOUR TRIBE</span><span><strong>02</strong> WATCH THE BATTLE</span><span><strong>03</strong> CLAIM YOUR OUTCOME</span></div>
        </div>
        <div
          id="practice"
          className="practice-card relative min-w-0 scroll-mt-32 overflow-hidden rounded-2xl border border-edge bg-[#161f26]"
        >
          <div className="flex items-center justify-between gap-3 border-b border-edge px-5 py-4">
            <span className="eyebrow text-neon-amber">✦ &nbsp; Practice chamber</span>
            <span className="font-mono text-[10px] text-mute">
              SIMULATION / NO FUNDS
            </span>
          </div>
          <PracticeScene selected={side} onSelect={setSide} selectable={step === "choose"} />
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
              {PRACTICE_TOKENS.map((token, s) => (
                <button
                  key={token}
                  disabled={step !== "choose"}
                  onClick={() => setSide(s)}
                  aria-pressed={side === s}
                  className={`relative rounded-lg border px-4 py-3 text-left transition-colors duration-200 disabled:cursor-default ${side === s ? "border-neon-green/60 bg-neon-green/10" : "border-edge enabled:hover:bg-white/5"}`}
                >
                  {side === s && (
                    <Check
                      size={14}
                      aria-hidden="true"
                      className="absolute right-3 top-3 text-neon-green"
                    />
                  )}
                  <span className="block font-pixel text-sm">
                    {token}
                  </span>
                  <span className="text-[10px] text-mute">
                    {side === s ? "Your practice tribe" : "Tribe " + (s + 1)}
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
                      Click a 3D podium or choose a tribe above to start the practice round.
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
                      Your practice tribe is ready. No assets move. Ready to see a 30-second practice round?
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
                      The practice tribes are locked in. This is a scripted practice interval.
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
                      CASHCAT wins this practice round.
                    </p>
                    <p className="mt-2 text-xs leading-6 text-mute">
                      {side === 0
                        ? "You chose the winning side. In an actual battle, inspect your claim in Portfolio."
                        : `You chose ${PRACTICE_TOKENS[side]}. In an actual battle, the losing side loses its deposited coins.`}
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
              30-second scripted walkthrough with five illustrative tribes. CASHCAT always wins this demo. Names reference researched tokens, not verified or approved assets. No wallet, transactions or live market data. Actual battles currently support two tribes.
            </p>
          </div>
        </div>
      </section>
      <div className="my-8"><TargetFlow page="arena" /></div>
      <section id="product-flow" className="flow-section scroll-mt-32">
        <div className="flow-section-heading">
          <div><p className="eyebrow text-neon-green">THE VALTRUM JOURNEY / PLANNED</p><h2 className="mt-3 text-3xl md:text-4xl">From community to outcome.</h2></div>
          <p className="max-w-md text-sm leading-7 text-mute">The target experience brings multiple communities into short rounds. The current arena below still uses its existing two-community rules.</p>
        </div>
        <div className="flow-grid">
          {[
            ["01", "Discover", "Find a battle and inspect its communities, scoring mode and audit status."],
            ["02", "Join a tribe", "Back an eligible community before deposits lock. The creator participates too."],
            ["03", "Follow the rounds", "A 30-second round picks a winner; tied leaders enter another round."],
            ["04", "Track your outcome", "Winning players receive losing-token entitlements; winning principal enters DAO escrow."],
          ].map(([number, title, description]) => <article className="flow-step" key={number}><span>{number}</span><h3>{title}</h3><p>{description}</p></article>)}
        </div>
        <div className="mt-7 border-t border-edge pt-6"><p className="eyebrow text-neon-amber">PLANNED / FOUR WAYS TO COMPETE</p><div className="mode-grid">{["Price % Gain", "Market Cap % Growth", "Volume-to-Market Cap", "Lowest % Drawdown"].map((mode) => <span key={mode}>{mode}</span>)}</div></div>
        <p className="mt-5 text-xs leading-6 text-mute">Planned product flow. Scoring modes, overtime, Robinhood payouts and DAO escrow are not yet available in the current app.</p>
      </section>
      <section
        id="mechanics"
        className="scroll-mt-32 border-t border-edge py-12 md:py-20"
      >
        <div className="mb-10 flex flex-wrap items-end justify-between gap-5">
          <div>
            <p className="eyebrow text-neon-green">
              The planned battle flow
            </p>
            <h2 className="mt-4 text-3xl tracking-tight md:text-5xl">
              One battle.
              <br />
              Separate outcomes.
            </h2>
          </div>
          <p className="max-w-sm text-sm leading-7 text-mute">
            A clear path from joining a community to tracking rewards and the DAO decision.
          </p>
        </div>
        <div className="mechanics-grid grid gap-3 md:grid-cols-3">
          {STEPS.map((item) => (
            <article
              key={item.number}
              className="mechanics-card border border-edge p-6"
            >
              <span className="mechanics-number font-mono text-4xl text-neon-green/35">
                {item.number}
              </span>
              <h3 className="mt-5 text-xl">{item.title}</h3>
              <p className="mt-3 text-sm leading-7 text-mute">{item.text}</p>
            </article>
          ))}
        </div>
      </section>
      <MemeMechanics />
      <section className="target-flow">
        <div className="target-flow-top"><div><p className="eyebrow text-neon-amber">PLANNED / AFTER THE FINAL ROUND</p><h2 className="mt-4 text-3xl">Two paths after a battle.</h2><p className="mt-4 max-w-xl text-sm leading-7 text-mute">The target design separates losing-token rewards from the winning community’s principal. Neither path implies an automatic transfer or burn.</p></div><span className="target-flow-status">NOT AVAILABLE YET</span></div>
        <div className="outcome-grid"><article><span className="eyebrow text-neon-green">01 / LOSING VAULTS</span><h3>Original-token rewards</h3><p>Winners receive an entitlement in each losing token. Allocation, pending payout and confirmed receipt are distinct states.</p></article><article><span className="eyebrow text-neon-cyan">02 / WINNING PRINCIPAL</span><h3>DAO escrow</h3><p>Winning principal stays in escrow until a DAO decision to burn or return it. Governance rules are still open.</p></article></div>
        <p className="mt-5 text-xs leading-6 text-mute">Planned mechanics. The current arena uses different settlement and balance rules.</p>
      </section>
      <section className="track-section" aria-label="What powers Valtrum">
        <p className="eyebrow text-neon-green">FOUR IDEAS / ONE ARENA</p><h2 className="mt-3 text-3xl">More than a meme.</h2>
        <div className="track-grid">{[
          ["01", "Meme coins with mechanics", "Communities compete; rival tokens become rewards."],
          ["02", "Games with real economies", "Locked vaults, 30-second rounds and transparent outcomes."],
          ["03", "Social money", "A community’s winning principal waits for a DAO decision."],
          ["04", "AI swarms", "User-funded player agents compete within delegated limits."],
        ].map(([number, title, text]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{text}</p></article>)}</div>
        <p className="mt-4 text-xs leading-6 text-mute">These are planned hackathon demonstrations. Player agents, DAO governance and target settlement are not yet available.</p>
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
