"use client";

import Link from "next/link";
import {
  ArrowUpRight,
  ShieldCheck,
  Plus,
} from "lucide-react";
import { KineticScene } from "./scene";
import { TargetFlow } from "@/components/target-flow";
import { MemeMechanics } from "@/components/meme-mechanics";

import { Button } from "@/components/ui/button";


const STEPS = [
  { number: "01", title: "Choose a community.", text: "Discover a battle with two or more communities. Check the scoring mode and audit status before joining." },
  { number: "02", title: "Play the round.", text: "Deposits lock before a 30-second round. Tied leaders advance to another round while all vaults remain locked." },
  { number: "03", title: "Follow the outcome.", text: "Winning players receive losing-token entitlements. Winning principal stays in DAO escrow for a burn or return decision." },
];

export function Landing() {
  return (
    <div className="landing-page">
      <div className="mb-5 flex items-center justify-between">
        <p className="eyebrow">01 / The community battleground</p>
        <span className="eyebrow hidden sm:block">VALTRUM — ARENA LOBBY</span>
      </div>
      <section className="machine-hero grid lg:grid-cols-[.95fr_1.05fr]">
        <div className="relative z-10 px-6 pt-9 sm:px-9 lg:py-14 lg:pl-12">
          <span className="inline-flex items-center gap-2 rounded-full border border-neon-green/25 bg-neon-green/5 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[.14em] text-neon-green"><span className="status-dot" /> Community battles / NEAR testnet</span>
          <h1 className="mt-6 text-[clamp(2.8rem,5.7vw,5.5rem)] font-medium leading-[.98] tracking-[-.065em]">Pick your tribe.<br /><span className="text-neon-green">Enter the arena.</span></h1>
          <p className="mt-5 max-w-sm text-sm leading-7 text-mute">Discover token communities, inspect their vaults and follow the battle. Choose your side while deposits are open.</p>
          <div className="mt-7 flex flex-wrap gap-3"><Button asChild size="lg"><Link href="/arena">Explore battles <ArrowUpRight size={16} /></Link></Button><Button asChild variant="ghost" size="lg"><Link href="/battles/new"><Plus size={15} /> Create battle</Link></Button></div>
          <div className="mt-8 flex flex-wrap gap-5 border-t border-edge/70 py-5 text-[10px] text-mute"><span>COMMUNITY VS COMMUNITY</span><span>TOKEN-BACKED VAULTS</span></div>
        </div>
        <div className="relative min-w-0"><div className="absolute right-6 top-6 z-10 hidden font-mono text-[9px] uppercase leading-5 tracking-widest text-mute/70 lg:block">Kinetic arena<br />Community rivalry</div><KineticScene className="h-[310px] sm:h-[400px] lg:h-full lg:min-h-[480px]" /></div>
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
