"use client";

import dynamic from "next/dynamic";
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Crosshair, Eye, Expand, Pause, Play } from "lucide-react";
import { useNow } from "@/hooks/use-now";
import type { BattleView, TokenMeta } from "@/lib/arena/types";
import { battleRoster, recordedRuntime } from "./battle-runtime";
import type { Contender, PreviewRuntime } from "./choreography";
import "./battle-arena.css";

const Scene = dynamic(() => import("./scene"), { ssr: false });
class Boundary extends Component<
  { children: ReactNode; onFailure: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    console.error("Valtrum 3D battle arena failed", error);
    this.props.onFailure();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function BattleArena({
  battle,
  tokens,
  selected,
  onSelect,
  chart,
  leaderToken,
}: {
  battle: BattleView;
  tokens: TokenMeta[];
  selected: string;
  onSelect: (token: string) => void;
  chart: ReactNode;
  leaderToken?: string | null;
}) {
  const identity = tokens.map((t) => `${t.id}:${t.symbol}`).join("|");
  const roster = useMemo(() => battleRoster(tokens), [identity]);
  return (
    <RecordedArena
      battleId={String(battle.id)}
      tokens={tokens}
      roster={roster}
      resolveRuntime={(now) => recordedRuntime(battle, roster, now)}
      selected={selected}
      onSelect={onSelect}
      chart={chart}
      leaderToken={leaderToken}
      provenance={battle.demo_communities ? "Simulated" : "Recorded"}
      waitingText={
        battle.status === "Live" || battle.status === "Settling"
          ? "Awaiting recorded result · no winner assigned"
          : `${battle.status} · inspect the battle details`
      }
    />
  );
}

/** Shared renderer/presentation; each protocol supplies its own authoritative adapter. */
export function RecordedArena({
  battleId,
  tokens,
  roster,
  resolveRuntime,
  selected,
  onSelect,
  chart,
  leaderToken,
  provenance,
  waitingText,
}: {
  battleId: string;
  tokens: Array<{ id: string; symbol: string }>;
  roster: Contender[];
  resolveRuntime: (now: number) => PreviewRuntime;
  selected: string;
  onSelect: (token: string) => void;
  chart?: ReactNode;
  leaderToken?: string | null;
  provenance: string;
  waitingText: string;
}) {
  const host = useRef<HTMLDivElement>(null),
    clock = useRef(0);
  const now = useNow(250);
  const [paused, setPaused] = useState(false),
    [reduced, setReduced] = useState(true),
    [visible, setVisible] = useState(true),
    [inView, setInView] = useState(true),
    [ready, setReady] = useState(false),
    [support, setSupport] = useState<"checking" | "supported" | "failed">(
      "checking",
    ),
    [camera, setCamera] = useState<"overview" | "follow">("overview"),
    [notice, setNotice] = useState(""),
    [entering, setEntering] = useState(true);
  const identity = tokens.map((t) => `${t.id}:${t.symbol}`).join("|");
  const runtime = useRef(resolveRuntime(0));
  runtime.current = {
    ...resolveRuntime(now),
    time: clock.current,
    selected: Math.max(
      0,
      tokens.findIndex((t) => t.id === selected),
    ),
    camera,
    reduced,
    paused: paused || !visible || !inView,
    chartLeader: leaderToken
      ? tokens.findIndex((t) => t.id === leaderToken)
      : null,
  };
  useEffect(() => {
    if (!ready) return;
    if (reduced) {
      setEntering(false);
      return;
    }
    const timer = window.setTimeout(() => setEntering(false), 1000);
    return () => window.clearTimeout(timer);
  }, [ready, reduced]);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)"),
      motion = () => setReduced(media.matches),
      visibility = () => setVisible(!document.hidden);
    motion();
    visibility();
    media.addEventListener("change", motion);
    document.addEventListener("visibilitychange", visibility);
    setSupport("supported");
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry?.isIntersecting ?? false),
      { rootMargin: "150px" },
    );
    if (host.current) observer.observe(host.current);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", motion);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    if (
      paused ||
      reduced ||
      !visible ||
      !inView ||
      support !== "supported" ||
      !ready
    )
      return;
    let frame = 0,
      previous = performance.now();
    const tick = (time: number) => {
      clock.current += Math.min(0.05, (time - previous) / 1000);
      previous = time;
      runtime.current.time = clock.current;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [paused, reduced, visible, inView, support, ready]);
  const fail = useCallback(() => setSupport("failed"), []),
    loaded = useCallback(() => setReady(true), []);
  const select = useCallback(
    (index: number) => {
      const token = tokens[index];
      if (token) onSelect(token.id);
    },
    [tokens, onSelect],
  );
  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await host.current?.requestFullscreen();
    } catch {
      setNotice(
        "Fullscreen is unavailable. All arena controls remain available here.",
      );
    }
  };
  const round = runtime.current.externalRound!;
  const status =
    round.winner !== null
      ? `${tokens[round.winner]?.symbol} wins · recorded result`
      : round.stage === "fighting"
        ? "Battle live · deposits closed"
        : waitingText;
  return (
    <section
      ref={host}
      className="battle-arena"
      aria-label={`3D arena for battle ${battleId}`}
    >
      <div className="battle-arena-toolbar">
        <div>
          <span className="eyebrow">
            Battle #{battleId} / {provenance} state
          </span>
          <p role="status">{status}</p>
        </div>
        <div role="group" aria-label="Arena view controls">
          <button
            aria-label="Overview camera"
            aria-pressed={camera === "overview"}
            onClick={() => setCamera("overview")}
          >
            <Eye size={17} />
          </button>
          <button
            aria-label="Follow highlighted community"
            aria-pressed={camera === "follow"}
            onClick={() => setCamera("follow")}
          >
            <Crosshair size={17} />
          </button>
          <button
            aria-label={
              paused ? "Resume cosmetic animation" : "Pause cosmetic animation"
            }
            aria-pressed={paused}
            onClick={() => setPaused((v) => !v)}
          >
            {paused ? <Play size={17} /> : <Pause size={17} />}
          </button>
          <button aria-label="Toggle arena fullscreen" onClick={fullscreen}>
            <Expand size={17} />
          </button>
        </div>
      </div>
      <div className="battle-arena-stage">
        {ready && entering && !reduced && (
          <div className="battle-arena-entry" aria-hidden="true">
            Entering battle #{battleId}
          </div>
        )}
        {support === "supported" && (
          <Boundary onFailure={fail}>
            <Scene
              key={identity}
              runtime={runtime}
              frozen={paused || reduced || !visible || !inView}
              revision={`${selected}:${camera}:${round.round}:${round.stage}:${round.winner}:${round.candidates.join(",")}:${reduced}:${paused}`}
              onSelect={select}
              onReady={loaded}
              onFailure={fail}
            />
          </Boundary>
        )}
        {(support === "checking" || (support === "supported" && !ready)) && (
          <div className="battle-arena-message">
            Loading this battle’s arena…
          </div>
        )}
        {support === "failed" && (
          <div className="battle-arena-message">
            3D is unavailable. Community selection, chart and battle controls
            remain below.
            <button type="button" className="ml-2 underline" onClick={() => { setReady(false); setSupport("supported"); }}>Try 3D again</button>
          </div>
        )}
        <p className="battle-arena-caption">
          {round.stage === "fighting"
            ? "Personal reactor challenges · cosmetic choreography"
            : "Community arena · awaiting the recorded battle state"}
        </p>
      </div>
      <div
        className="battle-arena-roster"
        role="group"
        aria-label="Highlight a battle community without changing your deposit"
      >
        {roster.map((c, index) => (
          <button
            key={tokens[index]!.id}
            aria-pressed={tokens[index]!.id === selected}
            onClick={() => onSelect(tokens[index]!.id)}
            style={{ "--community": c.color } as React.CSSProperties}
          >
            <strong>{c.name}</strong>
            <span>
              {round.winner === index
                ? "Recorded winner"
                : c.generic
                  ? "3D token emblem"
                  : "Community character"}
            </span>
          </button>
        ))}
      </div>
      {chart && <div className="battle-arena-chart">{chart}</div>}
      <p className="battle-arena-note">
        Animation is for show only. It never assigns scores or a winner.
      </p>
      {notice && (
        <p className="battle-arena-note" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
