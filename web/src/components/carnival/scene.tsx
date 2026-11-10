"use client";
import dynamic from "next/dynamic";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { Pause, Play, Ticket } from "lucide-react";
import type { BattleControls } from "@/components/kinetic/battle-state";

export type CarnivalMode =
  | "welcome"
  | "arena"
  | "create"
  | "terminal"
  | "portfolio"
  | "battle";
export interface WorldProps {
  mode: CarnivalMode;
  selected: number;
  frozen: boolean;
  battle?: BattleControls;
  onSelect?: (index: number) => void;
  onFailure: () => void;
  onReady: () => void;
}
const World = dynamic(() => import("./world"), { ssr: false });
class WorldBoundary extends Component<
  { children: ReactNode; onFailure: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    console.error("Valtrum 3D scene failed", error);
    this.props.onFailure();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
const COPY = {
  welcome: "Meet the crew · original toy mascots",
  arena: "Community fairground · decorative",
  create: "Your workshop host · decorative",
  terminal: "Your command kiosk · decorative",
  portfolio: "Your keepsake cabinet · illustration, not balances",
  battle: "Community vaults · inspect the controls below",
};
export function CarnivalScene({
  mode = "welcome",
  className = "",
  selected = 0,
  onSelect,
  battle,
  caption,
}: {
  mode?: CarnivalMode;
  className?: string;
  selected?: number;
  onSelect?: (index: number) => void;
  battle?: BattleControls;
  caption?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [supported, setSupported] = useState(false),
    [failed, setFailed] = useState(false),
    [loaded, setLoaded] = useState(false),
    [near, setNear] = useState(false),
    [seen, setSeen] = useState(false),
    [visible, setVisible] = useState(true),
    [reduced, setReduced] = useState(true),
    [paused, setPaused] = useState(false);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const motion = () => setReduced(media.matches);
    motion();
    media.addEventListener("change", motion);
    const visibility = () => setVisible(!document.hidden);
    visibility();
    document.addEventListener("visibilitychange", visibility);
    const observer = new IntersectionObserver(
      ([entry]) => {
        const intersecting = entry?.isIntersecting ?? false;
        setNear(intersecting);
        if (intersecting) setSeen(true);
      },
      { rootMargin: "150px", threshold: 0.01 },
    );
    if (host.current) observer.observe(host.current);
    // Let the actual Canvas initialize WebGL. Extra probe contexts compete for
    // limited GPU resources during route transitions and Strict Mode remounts.
    setSupported(true);
    return () => {
      media.removeEventListener("change", motion);
      document.removeEventListener("visibilitychange", visibility);
      observer.disconnect();
    };
  }, []);
  return (
    <div ref={host} className={`carnival-scene ${className}`}>
      <div
        className="carnival-scene-canvas"
        role={onSelect || battle ? "group" : "img"}
        aria-label={
          battle
            ? "Illustrative community vaults. Use the community buttons and deposit controls below."
            : `${COPY[mode]}. Important actions are available outside this 3D illustration.`
        }
      >
        {(!loaded || failed) && (
          <div className="carnival-scene-poster" aria-hidden="true">
            <div />
            <Ticket size={40} strokeWidth={1.2} />
            <span>
              {failed
                ? "The fairground is taking a little break"
                : "A little world is waiting"}
            </span>
          </div>
        )}
        {supported && seen && !failed && (
          <WorldBoundary onFailure={() => setFailed(true)}>
            <World
              mode={mode}
              selected={selected}
              frozen={reduced || paused || !near || !visible}
              onSelect={onSelect}
              battle={battle}
              onReady={() => setLoaded(true)}
              onFailure={() => setFailed(true)}
            />
          </WorldBoundary>
        )}
      </div>
      <p className="carnival-scene-caption">
        {failed
          ? <button type="button" onClick={() => { setLoaded(false); setFailed(false); }}>3D could not load · Try again</button>
          : loaded
            ? (caption ?? COPY[mode])
            : "Preparing local 3D assets…"}
      </p>
      {!failed && loaded && !reduced && (
        <button
          type="button"
          aria-label={paused ? "Resume 3D animation" : "Pause 3D animation"}
          aria-pressed={paused}
          className="carnival-scene-pause"
          onClick={() => setPaused((v) => !v)}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </button>
      )}
    </div>
  );
}
