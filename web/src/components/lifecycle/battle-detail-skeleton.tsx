import Link from "next/link";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import { RaceChartSkeleton } from "@/components/battle-chart/loading";

/** Uses the same HUD containers and breakpoints as the loaded arena. */
export function BattleDetailSkeleton({ battleId }: { battleId: string }) {
  return (
    <SkeletonGroup label={`Preparing battle #${battleId}…`} className="lifecycle-page immersive-match match-loading">
      <nav className="match-navigation" aria-label="Battle navigation">
        <Link href="/arena">← Lobby</Link>
        <span className="match-navigation-brand">VALTRUMS <span>/ ARENA</span></span>
        <div className="ml-auto flex gap-2"><Skeleton style={{ width: 150, height: 44, borderRadius: 12 }} /><Skeleton style={{ width: 90, height: 44, borderRadius: 12 }} /></div>
      </nav>
      <section className="battle-arena battle-arena--match" aria-hidden="true">
        <div className="battle-arena-scoreboard">
          <div className="space-y-2"><Skeleton style={{ width: 80, height: 10 }} /><Skeleton style={{ width: 190, maxWidth: "100%", height: 24 }} /></div>
          <div className="match-clock space-y-2"><Skeleton style={{ width: 100, height: 10 }} /><Skeleton style={{ width: 100, height: 38 }} /></div>
          <div className="match-status space-y-2"><Skeleton style={{ width: 65, height: 10 }} /><Skeleton style={{ width: 110, height: 18 }} /></div>
        </div>
        <div className="battle-arena-toolbar"><div /><div role="group" aria-label="Loading view controls">{[0, 1, 2].map((n) => <Skeleton key={n} style={{ width: 44, height: 44, borderRadius: 12 }} />)}</div></div>
        <div className="battle-arena-stage match-loading-stage"><Skeleton className="match-loading-platform" /></div>
        <div className="battle-arena-chart">
          <div className="match-dock">
            <div className="match-dock-tabs"><Skeleton style={{ width: "50%", height: 44, borderRadius: 10 }} /><Skeleton style={{ width: "50%", height: 44, borderRadius: 10 }} /></div>
            <RaceChartSkeleton />
          </div>
        </div>
      </section>
    </SkeletonGroup>
  );
}
