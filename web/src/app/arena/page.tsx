"use client";

import { Card } from "@/components/ui/card";
import { useApplicationDeployment } from "@/components/providers";
import { ApplicationBattleList } from "@/components/application-battle-list";

/** The battle list: lifecycle battles read from the configured deployment. There is no other source. */
export default function ArenaPage() {
  const deployment = useApplicationDeployment();
  if (!deployment) {
    return <Card role="alert">Battles are currently unavailable. Please try again later.</Card>;
  }
  return <ApplicationBattleList namespace={deployment} />;
}
