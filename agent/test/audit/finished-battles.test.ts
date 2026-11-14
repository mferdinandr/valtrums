// FIXTURE-ONLY: a fake transport counts the views the audit reads; no network is contacted.
import { describe, expect, it } from "vitest";
import { NearLifecycleAuditSource, type LifecycleBattleView } from "../../src/audit/lifecycle-pass.js";

const base: LifecycleBattleView = { locked: false, communities: [] };

function transport(views: Record<number, LifecycleBattleView>) {
  const reads: number[] = [];
  return {
    reads,
    view: async <T>(_c: string, method: string, args: object): Promise<T | undefined> => {
      if (method === "get_lifecycle_battle_count") return Object.keys(views).length as T;
      const id = (args as { battle_id: number }).battle_id;
      reads.push(id);
      return (views[id] ?? null) as T;
    },
  };
}

describe("NearLifecycleAuditSource", () => {
  it("reads a locked battle once and keeps it, because it never changes back", async () => {
    const t = transport({ 1: { ...base, locked: true } });
    const source = new NearLifecycleAuditSource("arena.test", t);
    await source.get(1);
    await source.get(1);
    await source.get(1);
    expect(t.reads).toEqual([1]);
  });
  it("keeps a cancelled battle too", async () => {
    const t = transport({ 2: { ...base, cancelled: true } });
    const source = new NearLifecycleAuditSource("arena.test", t);
    await source.get(2);
    await source.get(2);
    expect(t.reads).toEqual([2]);
  });
  it("reads an open battle every time, so a join or a lock is never missed", async () => {
    const views: Record<number, LifecycleBattleView> = { 3: { ...base } };
    const t = transport(views);
    const source = new NearLifecycleAuditSource("arena.test", t);
    expect((await source.get(3))?.locked).toBe(false);
    views[3] = { ...base, locked: true };
    expect((await source.get(3))?.locked).toBe(true);
    await source.get(3);
    expect(t.reads).toEqual([3, 3]);
  });
  it("does not keep a battle that is not there yet", async () => {
    const views: Record<number, LifecycleBattleView> = {};
    const t = transport(views);
    const source = new NearLifecycleAuditSource("arena.test", t);
    expect(await source.get(4)).toBeNull();
    views[4] = { ...base, locked: true };
    expect((await source.get(4))?.locked).toBe(true);
  });
});
