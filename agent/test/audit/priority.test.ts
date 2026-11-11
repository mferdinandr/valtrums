// FIXTURE-ONLY: fake arena views and providers. No network.
import { describe, expect, it } from "vitest";
import { AuditSubmitter } from "../../src/audit/approval.js";
import { createLifecycleAuditPass, type LifecycleBattleView } from "../../src/audit/lifecycle-pass.js";
import { staticReferenceRegistry } from "../../src/reference-registry.js";
import { FIXTURE_RESOLVED, NOW, REF_CHAIN, REF_TOKEN, TOKEN, refGoplus, refLp, registry } from "./fixtures.js";

const community = (token: string) => ({
  chain_id: "46630",
  token_address: token,
  representation: "aa.token.testnet",
  custody_domain: "vault-1",
  reference_chain_id: REF_CHAIN,
  reference_address: REF_TOKEN,
});

describe("lifecycle audit priority", () => {
  it("audits a token that joins an already-visited battle before older battles", async () => {
    const views: Record<number, LifecycleBattleView> = {};
    for (let id = 1; id <= 5; id++) views[id] = { locked: false, communities: [community(TOKEN)] };

    const order: number[] = [];
    let joined = false;
    const source = {
      count: async () => 5,
      get: async (id: number) => views[id] ?? null,
    };
    const pass = createLifecycleAuditPass({
      source,
      refresh: {
        policy: FIXTURE_RESOLVED,
        registry: staticReferenceRegistry(registry),
        now: () => NOW,
        refreshAheadMs: 60_000,
        fetchGoPlus: async () => refGoplus(),
        fetchLp: async () => refLp("10001"),
        submitter: new AuditSubmitter("arena.testnet", { call: async () => undefined } as never),
        records: new Map(),
      },
      log: {
        info: (msg: string, f?: Record<string, unknown>) => {
          if (msg !== "lifecycle audit checking battle") return;
          order.push(Number(f?.battleId));
          // Battle 5 finished; a token joins it while battle 4 is being audited.
          if (!joined && f?.battleId === 4) {
            joined = true;
            views[5] = { locked: false, communities: [community(TOKEN), community(TOKEN)] };
          }
        },
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      } as never,
    });

    await pass();
    // 5, 4 (join happens here), then 5 again before 3, 2, 1.
    expect(order.slice(0, 4)).toEqual([5, 4, 5, 3]);
    expect(order).toHaveLength(6);
  });
});
