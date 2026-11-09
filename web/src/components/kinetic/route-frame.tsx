"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import gsap from "gsap";
import { KineticScene } from "./scene";
import { config } from "@/lib/config";
import { BattleEntrance } from "./battle-entrance";

const ROUTES = {
  create: {
    label: "02 / Assembly bay",
    title: "Build your next rivalry.",
    note: "Choose two communities. Set the duration. Put a battle in motion.",
  },
  terminal: {
    label: "03 / Command core",
    title: "Your intent. In motion.",
    note: "Turn a simple instruction into a transaction you can review.",
  },
  portfolio: {
    label: "04 / Personal vault",
    title: "Every position. Accounted for.",
    note: "Your communities, liquid balances and credit, in one place.",
  },
  battle: {
    label: "01 / Battle chamber",
    title: "One arena. Two contenders.",
    note: "Follow the vaults, inspect your position and watch the outcome.",
  },
} as const;

export function RouteFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  const mode =
    pathname === "/battles/new"
      ? "create"
      : pathname.startsWith("/battles/")
        ? "battle"
        : pathname.startsWith("/terminal")
          ? "terminal"
          : pathname.startsWith("/portfolio")
            ? "portfolio"
            : null;
  useEffect(() => {
    const context = gsap.context(() => {
      const media = gsap.matchMedia();
      media.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.fromTo(
          ".route-reveal",
          { y: 18, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.65,
            stagger: 0.08,
            ease: "power3.out",
            clearProps: "all",
          },
        );
      });
    }, ref);
    return () => context.revert();
  }, [pathname]);
  const copy = mode ? ROUTES[mode] : null;
  return (
    <div ref={ref} className="route-content relative">
      {pathname === "/arena" && (
        <BattleEntrance
          id={0}
          symbols="THE ARENA"
          label="Arrival / Arena lobby"
          onceKey="valtrum:arena-arrival"
        />
      )}
      <p className="mb-4 flex items-center gap-2 text-[10px] text-mute sm:hidden">
        <span className="status-dot" />
        {config.mock
          ? "Demo mode · Simulated data and transactions"
          : `${config.network} · NEAR arena`}
      </p>
      {mode && mode !== "battle" && copy && (
        <section className="machine-hero route-reveal mb-8 grid items-center md:grid-cols-[1.1fr_1fr]">
          <div className="px-6 pt-8 md:px-9 md:py-9">
            <p className="eyebrow text-neon-green">{copy.label}</p>
            <h2 className="mt-4 max-w-lg text-3xl leading-tight md:text-4xl">
              {copy.title}
            </h2>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-mute">
              {copy.note}
            </p>
          </div>
          <KineticScene mode={mode} className="h-[230px] md:h-[250px]" />
        </section>
      )}
      <div key={pathname} className="route-reveal">
        {children}
      </div>
    </div>
  );
}
