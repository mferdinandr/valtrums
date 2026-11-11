import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import "./chart.css";

/** Mirrors the chart header, timeline and single-column crew list without implying sample values. */
export function RaceChartSkeleton() {
  return <SkeletonGroup label="Loading the race chart…" className="score-chart space-y-4">
    <div className="flex items-center justify-between gap-3"><Skeleton style={{ width: "55%", height: 20 }} /><Skeleton style={{ width: 44, height: 44, borderRadius: 12 }} /></div>
    <Skeleton style={{ width: "45%", height: 12 }} />
    <Skeleton style={{ width: "60%", height: 32, borderRadius: 20 }} />
    <Skeleton className="race-loading-plot" />
    <Skeleton style={{ width: "100%", height: 24 }} />
    <div className="space-y-2">{[0, 1, 2, 3].map((n) => <div key={n} className="race-loading-row"><Skeleton style={{ width: 16, height: 14 }} /><Skeleton className="skeleton-circle" style={{ width: 28, height: 28 }} /><Skeleton style={{ width: 65, height: 14 }} /><Skeleton className="ml-auto" style={{ width: "35%", height: 14 }} /></div>)}</div>
    <Skeleton style={{ width: "40%", height: 12 }} />
  </SkeletonGroup>;
}
