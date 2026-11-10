"use client";

import { useMemo } from "react";
import type { LifecycleDetail } from "@/lib/arena-read/lifecycle";
import { communityName } from "@/lib/arena-read/lifecycle-presentation";
import { RecordedArena } from "@/components/colosseum/battle-arena";
import {
  lifecycleRoster,
  lifecycleRuntime,
} from "@/components/colosseum/lifecycle-runtime";
import type { ReactNode } from "react";

export function LifecycleArena({
  detail,
  selected,
  onSelect,
  fixture,
  chart,
}: {
  detail: LifecycleDetail;
  selected: string;
  onSelect: (id: string) => void;
  fixture: boolean;
  chart?: ReactNode;
}) {
  const roster = useMemo(
    () => lifecycleRoster(detail.battle.communities),
    [detail.battle.communities],
  );
  const tokens = detail.battle.communities.map((community, index) => ({
    id: community.representation,
    symbol: roster[index]?.generic ? communityName(index) : roster[index]!.name,
  }));
  return (
    <RecordedArena
      key={detail.battleId}
      battleId={detail.battleId}
      tokens={tokens}
      roster={roster}
      resolveRuntime={(now) => lifecycleRuntime(detail, roster, now)}
      selected={selected}
      onSelect={onSelect}
      provenance={fixture ? "Fixture lifecycle" : "Recorded lifecycle"}
      chart={chart}
      waitingText={
        !detail.battle.locked
          ? "Meet the crews · deposits are still open"
          : !detail.round
            ? "Crews locked in · waiting for round one"
            : `Round ${detail.round.round_id} · awaiting the recorded window or result`
      }
    />
  );
}
