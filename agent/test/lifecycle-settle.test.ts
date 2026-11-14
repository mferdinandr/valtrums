import { describe, expect, it } from "vitest";
import { ENTITLEMENT_DEPOSIT_YOCTO, LifecycleSettler } from "../src/lifecycle-settle.js";

type Call = { method: string; args: Record<string, unknown>; gas: string; deposit?: string };

/** A fake arena: `battles[id]` is the settlement progress, null before a winner; each call records up to the batch. */
function fakeArena(battles: Record<number, { recorded: number; total: number } | null>, opts: { stall?: boolean } = {}) {
  const calls: Call[] = [];
  const transport = {
    async view<T>(_c: string, method: string, args: object): Promise<T | undefined> {
      if (method === "get_lifecycle_battle_count") return Object.keys(battles).length as T;
      const id = Number((args as { battle_id: string }).battle_id);
      return (battles[id] ?? null) as T;
    },
    async call(_c: string, method: string, args: object, gas: string, deposit?: string) {
      calls.push({ method, args: args as Record<string, unknown>, gas, ...(deposit ? { deposit } : {}) });
      const a = args as { battle_id: string; max_entitlements: number };
      const b = battles[Number(a.battle_id)];
      if (b && !opts.stall) b.recorded = Math.min(b.total, b.recorded + a.max_entitlements);
      return undefined;
    },
  };
  return { transport, calls };
}

const noSleep = async () => undefined;
const deps = (transport: ReturnType<typeof fakeArena>["transport"], extra = {}) => ({
  contractId: "arena.test",
  transport,
  now: () => new Date(1_000_000),
  sleep: noSleep,
  confirm: { tries: 2, delayMs: 0 },
  ...extra,
});

describe("LifecycleSettler", () => {
  it("settles a battle in batches of at most 15 with the deposit for exactly that batch", async () => {
    const { transport, calls } = fakeArena({ 1: { recorded: 0, total: 40 } });
    const out = await new LifecycleSettler(deps(transport)).pass();
    expect(out).toEqual({ settled: 40, errors: 0 });
    expect(calls.map((c) => c.args.max_entitlements)).toEqual([15, 15, 10]);
    expect(calls[0]?.method).toBe("settle_lifecycle_battle");
    expect(calls[0]?.args.battle_id).toBe("1");
    expect(calls[0]?.deposit).toBe(`${ENTITLEMENT_DEPOSIT_YOCTO * 15n} yocto`);
    expect(calls[2]?.deposit).toBe(`${ENTITLEMENT_DEPOSIT_YOCTO * 10n} yocto`);
  });

  it("does nothing for a battle without a settlement plan and revisits it later", async () => {
    const battles: Record<number, { recorded: number; total: number } | null> = { 1: null };
    const { transport, calls } = fakeArena(battles);
    const settler = new LifecycleSettler(deps(transport));
    expect(await settler.pass()).toEqual({ settled: 0, errors: 0 });
    expect(calls).toHaveLength(0);
    battles[1] = { recorded: 0, total: 3 };
    expect(await settler.pass()).toEqual({ settled: 3, errors: 0 });
  });

  it("never reads or sends again for a fully settled battle", async () => {
    const { transport, calls } = fakeArena({ 1: { recorded: 0, total: 2 } });
    const settler = new LifecycleSettler(deps(transport));
    await settler.pass();
    await settler.pass();
    expect(calls).toHaveLength(1);
  });

  it("reports a batch that does not advance as an error and backs off before retrying", async () => {
    let now = 1_000_000;
    const { transport, calls } = fakeArena({ 1: { recorded: 0, total: 2 } }, { stall: true });
    const settler = new LifecycleSettler(deps(transport, { now: () => new Date(now), retryAfterMs: 60_000 }));
    expect((await settler.pass()).errors).toBe(1);
    expect((await settler.pass()).errors).toBe(0);
    expect(calls).toHaveLength(1);
    now += 61_000;
    expect((await settler.pass()).errors).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("only visits the newest battles", async () => {
    const battles: Record<number, { recorded: number; total: number } | null> = {};
    for (let i = 1; i <= 30; i++) battles[i] = { recorded: 0, total: 1 };
    const { transport, calls } = fakeArena(battles);
    await new LifecycleSettler(deps(transport, { recentBattles: 3 })).pass();
    expect(calls.map((c) => c.args.battle_id)).toEqual(["30", "29", "28"]);
  });
});
