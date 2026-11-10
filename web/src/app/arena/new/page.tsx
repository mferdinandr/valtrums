"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { useApplicationDeployment } from "@/components/providers";
import { LifecycleCreateReview } from "@/components/lifecycle-create-review";

/** Lifecycle creation review. The former A/B creation flow is gone; /battles/new redirects here. */
export default function NewLifecycleBattlePage() {
  const deployment = useApplicationDeployment();
  if (!deployment) {
    return (
      <Card role="alert">
        Creating a battle is currently unavailable. Please try again later.{" "}
        <Link href="/arena" className="underline">Back to the battle list</Link>
      </Card>
    );
  }
  return <LifecycleCreateReview namespace={deployment} />;
}
