"use client";

import { use } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { useApplicationDeployment } from "@/components/providers";
import { LifecycleBattleDetail } from "@/components/lifecycle-battle-detail";

/**
 * Lifecycle battle detail for an application deployment. Without a configured deployment there is
 * nothing to read: the page says so and does not fall back to the legacy A/B pages or to demo data.
 * The legacy flow stays at /battles/*.
 */
export default function LifecycleBattlePage({ params }: { params: Promise<{ battleId: string }> }) {
  const { battleId } = use(params);
  const deployment = useApplicationDeployment();
  if (!/^[1-9][0-9]{0,19}$/.test(battleId)) {
    return <Card role="alert" className="border-neon-red text-neon-red">Invalid battle id.</Card>;
  }
  if (!deployment) {
    return (
      <Card role="alert">
        Lifecycle reads are not configured for this deployment, so battle #{battleId} cannot be shown.{" "}
        <Link href="/arena" className="underline">Back to the battle list</Link>
      </Card>
    );
  }
  return <LifecycleBattleDetail namespace={deployment} battleId={battleId} />;
}
