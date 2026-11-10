"use client";
import { CarnivalScene, type CarnivalMode } from "@/components/carnival/scene";
import type { BattleControls } from "./battle-state";
/** Compatibility entry point for existing feature components. */
export function KineticScene({
  mode = "arena",
  className = "",
  battle,
}: {
  mode?: Exclude<CarnivalMode, "welcome">;
  className?: string;
  battle?: BattleControls;
}) {
  return <CarnivalScene mode={mode} className={className} battle={battle} />;
}
