"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import type { ReactNode } from "react";
import { useApplicationDeployment } from "@/components/providers";
import { Card } from "@/components/ui/card";

export function ApplicationReadBoundary({ children }: { children: ReactNode }) {
  const deployment = useApplicationDeployment();
  const path = usePathname();
  if (deployment && path !== "/arena") return <Card role="status">
    <p>This page is unavailable for the selected application deployment.</p>
    <Link className="mt-3 inline-block text-neon-green underline" href="/arena">Browse battles</Link>
  </Card>;
  return children;
}
