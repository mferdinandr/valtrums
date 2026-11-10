"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

/** A nonblocking arrival sequence; essential controls are never gated by it. */
export function BattleEntrance({
  id,
  symbols,
  label,
  onceKey,
}: {
  id: number;
  symbols: string;
  label?: string;
  onceKey?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (onceKey) {
      try {
        if (sessionStorage.getItem(onceKey)) {
          gsap.set(root.current, { visibility: "hidden" });
          return;
        }
      } catch {
        /* Storage availability does not gate navigation. */
      }
    }
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      const context = gsap.context(() => {
        const sequence = gsap.timeline();
        const panel = root.current?.parentElement?.querySelector(
          "[data-deck-controls]",
        );
        if (panel)
          sequence.fromTo(
            panel,
            { opacity: 0, x: 20 },
            { opacity: 1, x: 0, duration: 0.55, clearProps: "all" },
            0.5,
          );
        sequence.fromTo(
          ".portal-copy",
          { opacity: 0, y: 10 },
          { opacity: 1, y: 0, duration: 0.25 },
          0,
        );
        sequence.to(".portal-copy", { opacity: 0, duration: 0.25 }, 0.45);
        sequence.to(
          ".portal-left",
          { xPercent: -103, duration: 1.05, ease: "power3.inOut" },
          0.2,
        );
        sequence.to(
          ".portal-right",
          { xPercent: 103, duration: 1.05, ease: "power3.inOut" },
          0.2,
        );
        sequence.set(root.current, { visibility: "hidden" });
        if (onceKey)
          sequence.call(() => {
            try {
              sessionStorage.setItem(onceKey, "seen");
            } catch {
              /* Optional session preference. */
            }
          });
      }, root);
      return () => context.revert();
    });
    return () => media.revert();
  }, [id, onceKey]);
  return (
    <div
      ref={root}
      aria-hidden="true"
      className="battle-portal pointer-events-none absolute inset-0 z-20 overflow-hidden rounded-xl"
    >
      <div className="portal-left absolute inset-y-0 left-0 w-1/2 border-r border-neon-green/20 bg-[#e7ecdf]" />
      <div className="portal-right absolute inset-y-0 right-0 w-1/2 border-l border-neon-pink/20 bg-[#f2dfdc]" />
      <div className="portal-copy absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="eyebrow text-neon-green">
          {label ?? `Entering battle / ${id.toString().padStart(3, "0")}`}
        </span>
        <span className="mt-4 font-pixel text-2xl sm:text-4xl">{symbols}</span>
        <span className="mt-4 font-mono text-[10px] uppercase tracking-[.3em] text-mute">
          Your community booth is opening
        </span>
      </div>
    </div>
  );
}
