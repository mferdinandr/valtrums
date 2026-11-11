import Link from "next/link";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";

/** Uses the same HUD containers and breakpoints as the loaded arena. */
export function BattleDetailSkeleton({ battleId }: { battleId: string }) {
  return (
    <SkeletonGroup label={`Preparing battle #${battleId}…`} className="lifecycle-page immersive-match match-loading">
      <nav className="match-navigation" aria-label="Battle navigation">
        <Link href="/arena">← Lobby</Link>
        <Skeleton className="ml-auto" style={{ width: 150, height: 36, borderRadius: 12 }} />
      </nav>
      <section className="battle-arena battle-arena--match" aria-hidden="true">
        <div className="battle-arena-scoreboard">
          <div className="space-y-2"><Skeleton style={{ width: 80, height: 10 }} /><Skeleton style={{ width: 190, maxWidth: "100%", height: 24 }} /></div>
          <div className="match-clock space-y-2"><Skeleton style={{ width: 100, height: 10 }} /><Skeleton style={{ width: 100, height: 38 }} /></div>
          <div className="match-status space-y-2"><Skeleton style={{ width: 65, height: 10 }} /><Skeleton style={{ width: 110, height: 18 }} /></div>
        </div>
        <div className="battle-arena-toolbar"><div /><div role="group" aria-label="Loading view controls">{[0, 1, 2].map((n) => <Skeleton key={n} style={{ width: 44, height: 44, borderRadius: 12 }} />)}</div></div>
        <div className="battle-arena-stage match-loading-stage"><Skeleton className="match-loading-platform" /></div>
        <div className="battle-arena-roster">{[0, 1, 2, 3].map((n) => <div className="match-loading-crew" key={n}><Skeleton className="skeleton-circle" style={{ width: 32, height: 32 }} /><Skeleton style={{ width: 55, height: 12 }} /></div>)}</div>
        <div className="battle-arena-chart">
          <div className="match-loading-chart space-y-4">
            <div className="flex items-center justify-between gap-3"><Skeleton style={{ width: "55%", height: 20 }} /><Skeleton style={{ width: 36, height: 36, borderRadius: 10 }} /></div>
            <Skeleton style={{ width: "45%", height: 12 }} />
            <Skeleton style={{ width: "60%", height: 30, borderRadius: 20 }} />
            <Skeleton className="match-loading-plot" />
            <Skeleton style={{ width: "100%", height: 10 }} />
            <div className="grid grid-cols-2 gap-2">{[0, 1, 2, 3].map((n) => <Skeleton key={n} style={{ height: 50, borderRadius: 10 }} />)}</div>
          </div>
        </div>
      </section>
    </SkeletonGroup>
  );
}
