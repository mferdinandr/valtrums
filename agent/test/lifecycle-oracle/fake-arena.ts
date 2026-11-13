// FIXTURE-ONLY: an in-memory model of the arena's round state machine. Not a deployed contract.
import type { LifecycleViews } from "../../src/lifecycle-oracle/driver.js";

interface FakeRound { id: number; candidates: number[]; start: bigint | null; end: bigint | null; winner: number | null }
export interface FakeBattle {
  locked: boolean; mode: "PriceGain" | "MarketCapGrowth" | "VolumeRatio" | "LowestDrawdown"; policyHash: string | null;
  round: FakeRound | null;
}

export class FakeArena {
  readonly battles = new Map<string, FakeBattle>();
  readonly calls: Array<{ method: string; args: Record<string, unknown>; deposit?: string }> = [];
  oracle: string | null = "oracle.testnet";
  paused = false;
  activated = true;
  /** Next call applies to state, then throws (a lost response). */
  loseResponseOnce = false;
  /** Next call throws before applying. */
  failBeforeApplyOnce = false;
  failViewsFor = new Set<string>();
  constructor(private readonly clock: () => number) {}

  lockedBattle(id: string, over: Partial<FakeBattle> = {}) {
    this.battles.set(id, { locked: true, mode: "PriceGain", policyHash: "policy-hash-1", round: null, ...over });
  }

  views: LifecycleViews = {
    count: async () => String(Math.max(0, ...[...this.battles.keys()].map(Number))),
    battle: async (id) => {
      if (this.failViewsFor.has(id)) throw new Error("view failed");
      const b = this.battles.get(id);
      return b ? { locked: b.locked, mode: b.mode, observation_policy_hash: b.policyHash } : null;
    },
    round: async (id) => {
      const r = this.battles.get(id)?.round;
      return r ? { round_id: String(r.id), candidates: r.candidates, start_ns: r.start?.toString() ?? null, end_ns: r.end?.toString() ?? null, winner: r.winner } : null;
    },
    readiness: async () => ({ activated: this.activated, paused: this.paused, oracle: this.oracle }),
  };

  call = async (_contract: string, method: string, args: object, _gas: string, deposit?: string): Promise<unknown> => {
    const a = args as Record<string, unknown>;
    this.calls.push({ method, args: a, ...(deposit ? { deposit } : {}) });
    if (this.failBeforeApplyOnce) { this.failBeforeApplyOnce = false; throw new Error("rpc timeout"); }
    this.apply(method, a, deposit);
    if (this.loseResponseOnce) { this.loseResponseOnce = false; throw new Error("response lost"); }
    return undefined;
  };

  /** Method lists of every batch transaction, in order. */
  readonly batches: string[][] = [];
  /** The next batch fails inside the chain: every action of it is reverted, like a failed NEAR receipt. */
  failBatchOnce = false;

  /** One transaction with several function-call actions: applied in order and atomically (all or nothing). */
  batch = async (_contract: string, actions: Array<{ method: string; args: object; gas: string; deposit?: string }>): Promise<unknown> => {
    this.batches.push(actions.map((x) => x.method));
    for (const x of actions) this.calls.push({ method: x.method, args: x.args as Record<string, unknown>, ...(x.deposit ? { deposit: x.deposit } : {}) });
    const b = this.battles.get(String((actions[0]?.args as Record<string, unknown> | undefined)?.battle_id));
    const saved = b?.round ? { ...b.round } : null;
    try {
      if (this.failBatchOnce) { this.failBatchOnce = false; throw new Error("Smart contract panicked: Round rejected: StartOutsideSkew"); }
      for (const x of actions) this.apply(x.method, x.args as Record<string, unknown>, x.deposit);
    } catch (err) {
      if (b) b.round = saved;
      throw err;
    }
    return undefined;
  };

  private apply(method: string, a: Record<string, unknown>, deposit?: string) {
    const b = this.battles.get(String(a.battle_id));
    if (!b || !b.locked) throw new Error("Battle is not locked");
    if (method === "start_lifecycle_rounds") {
      if (b.round) throw new Error("Rounds already started");
      if (!deposit) throw new Error("Insufficient storage deposit");
      b.round = { id: 1, candidates: [0, 1, 2], start: null, end: null, winner: null };
    } else if (method === "open_lifecycle_round") {
      const r = b.round;
      if (!r) throw new Error("Rounds not started");
      const start = BigInt(String(a.start_ns));
      if (r.winner !== null) throw new Error("Finished");
      if (String(a.round_id) !== String(r.id)) throw new Error("WrongRound");
      if (r.start !== null) { if (r.start !== start) throw new Error("AlreadyOpen"); return; }
      r.start = start; r.end = start + 30_000_000_000n;
    } else if (method === "reopen_lifecycle_round") {
      // Mirrors the arena: only an open, unresolved window at least 120 s past its end; the round keeps its id.
      const r = b.round;
      if (!r || r.start === null || r.end === null) throw new Error("The round has no open window");
      if (r.winner !== null) throw new Error("The round is already resolved");
      if (BigInt(this.clock()) * 1_000_000n < r.end + 120_000_000_000n) throw new Error("The round is still within its grace period");
      r.start = null; r.end = null;
    } else if (method === "submit_lifecycle_observations") {
      const r = b.round;
      if (!r) throw new Error("Rounds not started");
      if (Number(a.round_id) < r.id || r.winner !== null) return; // already recorded: returns the recorded outcome
      if (r.end === null || BigInt(this.clock()) * 1_000_000n < r.end) throw new Error("Round has not ended");
      const obs = a.observations as Array<{ community: number; data: { Price: { start: string; end: string } } }>;
      if ([...obs.map((o) => o.community)].sort().join() !== [...r.candidates].sort().join()) return; // pending: nothing recorded
      const score = (o: (typeof obs)[number]) => ({ num: BigInt(o.data.Price.end) - BigInt(o.data.Price.start), den: BigInt(o.data.Price.start) });
      let leaders: number[] = [];
      let best = score(obs[0]!);
      for (const o of obs) {
        const s = score(o);
        const order = s.num * best.den - best.num * s.den;
        if (leaders.length === 0 || order > 0n) { best = s; leaders = [o.community]; } else if (order === 0n) leaders.push(o.community);
      }
      if (leaders.length === 1) r.winner = leaders[0]!;
      else { r.candidates = leaders.sort(); r.id += 1; r.start = null; r.end = null; }
    }
  }
}
