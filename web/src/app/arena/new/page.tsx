"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { useApplicationDeployment } from "@/components/providers";
import { LifecycleCreateReview } from "@/components/lifecycle-create-review";

/** Lifecycle creation review. The legacy A/B creation flow stays at /battles/new, separately labeled. */
export default function NewLifecycleBattlePage() {
  const deployment = useApplicationDeployment();
  if (!deployment) {
    return (
      <Card role="alert">
        Lifecycle reads are not configured for this deployment, so a lifecycle battle cannot be reviewed here.{" "}
        <Link href="/arena" className="underline">Back to the battle list</Link>
      </Card>
    );
  }
  return <LifecycleCreateReview namespace={deployment} />;
}
