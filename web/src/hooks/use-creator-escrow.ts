"use client";

import { useEffect, useState } from "react";
import { readCreatorEscrow, type CreatorEscrow } from "@/lib/arena-read/positions";
import { config } from "@/lib/config";

const POLL_MS = 5_000;

/** The creator escrow of a battle while the arena holds it (D41); null once converted or when there is none. */
export function useCreatorEscrow(arena: string, battleId: number | null): CreatorEscrow | null {
  const [escrow, setEscrow] = useState<CreatorEscrow | null>(null);
  useEffect(() => {
    if (battleId === null) return;
    let live = true;
    const read = () =>
      readCreatorEscrow(config.rpcUrl, arena, battleId)
        .then((e) => live && setEscrow(e))
        .catch(() => undefined);
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [arena, battleId]);
  return escrow;
}
