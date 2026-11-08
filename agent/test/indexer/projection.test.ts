// FIXTURE-ONLY: events parsed from synthetic blocks; the reducer is pure.
import { describe, expect, it } from "vitest";
import { parseBlock } from "../../src/indexer/parser.js";
import { buildProjection } from "../../src/indexer/projection.js";
import type { AcceptedEvent } from "../../src/indexer/types.js";
import { CONTRACT, NETWORK, auditUpdated, block, config, created, deposit, outcome } from "./fixtures.js";

function events(): AcceptedEvent[] {
  const b1 = block({
    height: "10",
    outcomes: [outcome("r1", [created(1, "alice.testnet")]), outcome("r2", [auditUpdated(1, 0, "pending")])],
  });
  const b2 = block({
    height: "11",
    outcomes: [
      outcome("r3", [auditUpdated(1, 0, "pass"), deposit(1, 0, "bob.testnet", "1000")]),
      outcome("r4", [deposit(1, 0, "carol.testnet", "500")]),
    ],
  });
  return [...parseBlock(b1, config()).accepted, ...parseBlock(b2, config()).accepted];
}

const opts = (finalizedHeight = 10n) => ({ finalizedHeight, reducerVersion: "projection-v1" });

describe("buildProjection", () => {
  it("is deterministic regardless of input order or duplicate delivery", () => {
    const ev = events();
    const a = buildProjection(ev, opts());
    const shuffled = [...ev].reverse();
    const withDupes = [...shuffled, ev[0]!, ev[2]!];
    const b = buildProjection(withDupes, opts());
    expect(b.digest).toBe(a.digest);
  });

  it("sums credited amounts per community exactly and tracks the latest audit", () => {
    const p = buildProjection(events(), opts());
    const battle = p.battles[`${NETWORK}|${CONTRACT}|1`]!;
    expect(battle.creator).toBe("alice.testnet");
    expect(battle.creditedByCommunity["0"]).toBe("1500");
    expect(battle.latestAuditByCommunity["0"]).toMatchObject({ result: "pass" });
    expect(battle.audits).toHaveLength(2);
    expect(battle.deposits).toHaveLength(2);
  });

  it("labels finality from the finalized height without rewriting results", () => {
    const ev = events();
    const low = buildProjection(ev, opts(10n)).battles[`${NETWORK}|${CONTRACT}|1`]!;
    expect(low.created?.finalized).toBe(true); // height 10 <= 10
    expect(low.deposits.every((d) => d.ref.finalized)).toBe(false); // deposits are at height 11
    const high = buildProjection(ev, opts(11n)).battles[`${NETWORK}|${CONTRACT}|1`]!;
    expect(high.deposits.every((d) => d.ref.finalized)).toBe(true);
  });

  it("namespaces by network and contract so shared battle ids do not collide", () => {
    const here = parseBlock(block({ height: "1", outcomes: [outcome("r1", [created(1, "alice.testnet")])] }), config()).accepted;
    const otherNet = parseBlock(
      block({ height: "1", network: "near-mainnet", outcomes: [outcome("r9", [created(1, "zoe.testnet")])] }),
      config({ network: "near-mainnet" }),
    ).accepted;
    const p = buildProjection([...here, ...otherNet], opts(1n));
    expect(p.battles[`${NETWORK}|${CONTRACT}|1`]!.creator).toBe("alice.testnet");
    expect(p.battles[`near-mainnet|${CONTRACT}|1`]!.creator).toBe("zoe.testnet");
  });
});
