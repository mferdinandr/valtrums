import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A quiet placeholder block with a slow shimmer. It is decorative; the group around it carries the status text. */
export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden="true" className={cn("skeleton", className)} style={style} />;
}

/** Wraps skeleton blocks: announces what is loading to screen readers and marks the area as busy. */
export function SkeletonGroup({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** Placeholder with the shape of a token card (icon, name, two lines). */
export function TokenCardSkeleton() {
  return (
    <div className="token-card" aria-hidden="true">
      <Skeleton className="skeleton-circle" style={{ width: 44, height: 44 }} />
      <Skeleton style={{ width: 70, height: 14 }} />
      <Skeleton style={{ width: 96, height: 12 }} />
      <Skeleton style={{ width: 60, height: 12 }} />
    </div>
  );
}

/** Placeholder with the shape of a crew card on the battle page. */
export function CrewCardSkeleton() {
  return (
    <div className="lifecycle-crew skeleton-card" aria-hidden="true">
      <div className="flex items-center gap-3">
        <Skeleton className="skeleton-circle" style={{ width: 44, height: 44 }} />
        <Skeleton style={{ width: 110, height: 18 }} />
      </div>
      <Skeleton className="mt-5" style={{ width: 48, height: 30 }} />
      <Skeleton className="mt-2" style={{ width: 90, height: 12 }} />
      <div className="mt-4 flex gap-2">
        <Skeleton style={{ width: 110, height: 22, borderRadius: 8 }} />
        <Skeleton style={{ width: 100, height: 22, borderRadius: 8 }} />
      </div>
    </div>
  );
}
