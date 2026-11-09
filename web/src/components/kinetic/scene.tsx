"use client";

import dynamic from "next/dynamic";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { Pause, Play, Box } from "lucide-react";
import type { MachineMode } from "./machine";
import type { BattleControls } from "./battle-state";

const Machine = dynamic(() => import("./machine"), { ssr: false });
const BattleMachine = dynamic(() => import("./battle-machine"), { ssr: false });

class SceneBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function KineticScene({
  mode = "arena",
  className = "",
  battle,
}: {
  mode?: MachineMode;
  className?: string;
  battle?: BattleControls;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);
  const [tabVisible, setTabVisible] = useState(true);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const motion = () => setReduced(media.matches);
    motion();
    media.addEventListener("change", motion);
    const c = document.createElement("canvas");
    const context = c.getContext("webgl2");
    if (context) {
      context.getExtension("WEBGL_lose_context")?.loseContext();
      setReady(true);
    } else setFailed(true);
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { threshold: 0.05 },
    );
    if (host.current) observer.observe(host.current);
    const visibility = () => setTabVisible(!document.hidden);
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      media.removeEventListener("change", motion);
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  const fallback = <div className="orbital-fallback" />;
  return (
    <div ref={host} className={`scene-floor relative ${className}`}>
      <div
        className="absolute inset-0"
        role={battle ? "group" : "img"}
        aria-label={
          battle
            ? "Interactive battle arena. Select a community using a podium or the buttons below."
            : `${mode === "portfolio" ? "Mechanical vaults" : mode === "terminal" ? "Mechanical assistant core" : "Token emblems on an orbital arena"}, decorative 3D illustration`
        }
      >
        {fallback}
        {ready && !failed && (
          <SceneBoundary fallback={fallback}>
            {battle ? (
              <BattleMachine
                controls={battle}
                reduced={reduced || paused || !visible || !tabVisible}
                onFailure={() => setFailed(true)}
              />
            ) : (
              <Machine
                mode={mode}
                reduced={reduced || paused || !visible || !tabVisible}
                onFailure={() => setFailed(true)}
              />
            )}
          </SceneBoundary>
        )}
      </div>
      <div className="absolute bottom-4 left-5 flex items-center gap-2 text-[9px] uppercase tracking-[.16em] text-mute">
        <Box size={12} />
        {failed
          ? "2D mode · controls available"
          : !ready
            ? "Preparing the arena…"
            : battle
              ? battle.selectable
                ? "Select a podium · inspect your vault"
                : "Vaults locked · follow the outcome"
              : "Kinetic sculpture · decorative"}
      </div>
      {ready && !failed && !reduced && (
        <button
          type="button"
          onClick={() => setPaused(!paused)}
          aria-label={paused ? "Resume 3D animation" : "Pause 3D animation"}
          aria-pressed={paused}
          className="absolute bottom-2 right-4 grid h-10 w-10 place-items-center rounded-full border border-edge bg-void/60 text-mute hover:text-neon-green"
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
      )}
    </div>
  );
}
