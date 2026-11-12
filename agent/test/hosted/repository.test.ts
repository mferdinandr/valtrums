// FIXTURE-ONLY: fake funds and round runner. The Postgres runs in-process (PGlite) from the real migration file.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseKek } from "../../src/hosted/crypto.js";
import { HostedAgents, HostedError, ModelBudget, type ManagerDeps } from "../../src/hosted/manager.js";
import { PgHostedRepository } from "../../src/hosted/pg-store.js";
import { FileHostedRepository, type HostedRepository } from "../../src/hosted/repository.js";
import { AgentStore } from "../../src/hosted/store.js";
import type { ModelProposer } from "../../src/player/model.js";
import { pgliteWithMigrations } from "./pglite.js";

const KEK = parseKek("11".repeat(32));
let counter = 0;

const makers: Array<[string, () => Promise<{ repo: HostedRepository; exports: (account: string) => Promise<number[]> }>]> = [
  [
    "file repository",
    async () => {
      const store = new AgentStore(null);
      return { repo: new FileHostedRepository(store, mkdtempSync(join(tmpdir(), "hosted-state-"))), exports: async (a) => store.get(a)?.exports ?? [] };
    },
  ],
  [
    "postgres repository",
    async () => {
      const { db } = await pgliteWithMigrations();
      const repo = new PgHostedRepository(db);
      return { repo, exports: (a) => repo.exportTimes(a) };
    },
  ],
];

describe.each(makers)("hosted agents on the %s", (_name, make) => {
  const setup = async (over: Partial<ManagerDeps> = {}, limits: Partial<ManagerDeps["limits"]> = {}) => {
    const { repo, exports } = await make();
    const rounds: string[] = [];
    const logs: Array<Record<string, unknown>> = [];
    let killed = false;
    const deps: ManagerDeps = {
      repo,
      kek: KEK,
      limits: { maxAgentsPerOwner: 2, maxModelCallsPerAgentHour: 12, maxModelCallsGlobalHour: 3, maxTokenWholePerAgent: 1_000, ...limits },
      killSwitch: () => killed,
      now: () => 1_000,
      newKey: () => {
        counter += 1;
        return { account: `acct${counter}`, publicKey: `ed25519:pk${counter}`, secretKey: `ed25519:sk${counter}` };
      },
      funds: async () => ({ nearYocto: 1n, tokenBase: [100n * 10n ** 18n] }),
      runRound: async (c, key) => void rounds.push(`${c.account}:${key}`),
      log: (e) => void logs.push(e),
      ...over,
    };
    return { m: new HostedAgents(deps), deps, repo, exports, rounds, logs, kill: () => (killed = true) };
  };
  const mk = (m: HostedAgents, owner = "o.testnet") => m.create(owner, { style: "crowd", sweep: false, keepWhole: 0 });

  it("never returns the key in the public view or the logs", async () => {
    const { m, logs } = await setup();
    const a = await mk(m);
    expect(JSON.stringify(a)).not.toContain("sk");
    expect(JSON.stringify(await m.get("o.testnet", a.account))).not.toContain("sk");
    expect(JSON.stringify(logs)).not.toContain("sk");
  });

  it("stores only the encrypted key", async () => {
    const { repo, m } = await setup();
    const a = await mk(m);
    const stored = await repo.get(a.account);
    expect(stored?.encryptedKey).toMatch(/^v1\./);
    expect(JSON.stringify(stored)).not.toContain("ed25519:sk");
  });

  it("keeps agents across a new manager on the same repository", async () => {
    const { m, deps } = await setup();
    const a = await mk(m);
    const again = new HostedAgents(deps);
    expect((await again.list("o.testnet")).map((x) => x.account)).toEqual([a.account]);
  });

  it("limits agents per owner", async () => {
    const { m } = await setup();
    await mk(m);
    await mk(m);
    await expect(mk(m)).rejects.toThrow(/at most 2/);
    await expect(mk(m, "other.testnet")).resolves.toBeTruthy();
  });

  it("holds the limit when creates run at the same time", async () => {
    const { m } = await setup({}, { maxAgentsPerOwner: 1 });
    const results = await Promise.allSettled([mk(m), mk(m), mk(m)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await m.list("o.testnet")).length).toBe(1);
  });

  it("isolates owners: others get not_found for status, start, stop and export", async () => {
    const { m } = await setup();
    const a = await mk(m);
    for (const f of [() => m.get("x.testnet", a.account), () => m.stop("x.testnet", a.account), () => m.exportKey("x.testnet", a.account), () => m.start("x.testnet", a.account)]) {
      await expect(f()).rejects.toMatchObject({ code: "not_found" });
    }
  });

  it("exports the key to its owner and records the export", async () => {
    const { m, exports } = await setup();
    const a = await mk(m);
    expect((await m.exportKey("o.testnet", a.account)).secretKey).toMatch(/^ed25519:sk/);
    expect(await exports(a.account)).toEqual([1_000]);
  });

  it("refuses to start an unfunded agent and one over the fund cap", async () => {
    const empty = await setup({ funds: async () => ({ nearYocto: 0n, tokenBase: [5n] }) });
    await expect(empty.m.start("o.testnet", (await mk(empty.m)).account)).rejects.toMatchObject({ code: "not_funded" });
    const rich = await setup({ funds: async () => ({ nearYocto: 1n, tokenBase: [1_001n * 10n ** 18n] }) });
    await expect(rich.m.start("o.testnet", (await mk(rich.m)).account)).rejects.toMatchObject({ code: "over_fund_cap" });
  });

  it("plays only while started, and not after stop", async () => {
    const { m, rounds } = await setup();
    const a = await mk(m);
    await m.tick();
    expect(rounds).toEqual([]);
    await m.start("o.testnet", a.account);
    await m.tick();
    expect(rounds).toHaveLength(1);
    await m.stop("o.testnet", a.account);
    await m.tick();
    expect(rounds).toHaveLength(1);
  });

  it("uses the operator's model cap and the owner as the sweep target", async () => {
    const { m, repo } = await setup();
    const a = await m.create("o.testnet", { style: "underdog", sweep: true, keepWhole: 50 });
    expect(m.config((await repo.get(a.account))!)).toMatchObject({ style: "underdog", maxModelCallsPerHour: 12, sweepTo: "o.testnet", keepWhole: 50 });
  });

  it("stops an agent after repeated errors and reports why", async () => {
    const { m } = await setup({ runRound: async () => { throw new Error("rpc down"); } });
    const a = await mk(m);
    await m.start("o.testnet", a.account);
    for (let i = 0; i < 3; i++) await m.tick();
    const v = await m.get("o.testnet", a.account);
    expect(v.running).toBe(false);
    expect(v.lastError).toMatch(/rpc down/);
  });

  it("the kill switch stops every agent before any round and blocks create and start", async () => {
    const { m, rounds, kill } = await setup();
    const a = await mk(m);
    await m.start("o.testnet", a.account);
    kill();
    await m.tick();
    expect(rounds).toEqual([]);
    expect((await m.get("o.testnet", a.account)).running).toBe(false);
    await expect(mk(m)).rejects.toThrow(/paused/);
    await expect(m.start("o.testnet", a.account)).rejects.toMatchObject({ code: "kill_switch" });
  });

  it("signs nothing when the repository cannot be read", async () => {
    const { m, deps, rounds } = await setup();
    const a = await mk(m);
    await m.start("o.testnet", a.account);
    deps.repo.running = async () => {
      throw new Error("database down");
    };
    await expect(m.tick()).rejects.toThrow(/database down/);
    expect(rounds).toEqual([]);
  });

  it("counts model calls per agent", async () => {
    const { m, repo } = await setup();
    const a = await mk(m);
    m.recordModelCall(a.account);
    m.recordModelCall(a.account);
    await new Promise((r) => setTimeout(r, 50));
    expect((await repo.get(a.account))?.modelCalls).toBe(2);
  });

  it("remembers play state across a restart", async () => {
    const { repo } = await setup();
    expect(await repo.loadState("acct-none")).toBeNull();
    const data = { version: 1 as const, acted: { "auto:acct1:7": { at: 5, actionId: "x", txHash: "h", status: "sent" } }, blocked: {}, failures: 0 };
    const a = await mk((await setup({ repo })).m);
    await repo.saveState(a.account, data);
    expect(await repo.loadState(a.account)).toEqual(data);
    await repo.saveState(a.account, { ...data, failures: 2 });
    expect((await repo.loadState(a.account))?.failures).toBe(2);
  });
});

describe("model budget", () => {
  const model: ModelProposer = { propose: async () => "answer" };
  it("caps calls across all agents per hour and counts them per agent", async () => {
    let now = 1_000;
    const seen: string[] = [];
    const wrapped = new ModelBudget(2, () => now, (a) => seen.push(a)).wrap(model);
    const input = (user: string) => ({ strategy: "crowd" as const, user, options: [], maxAmount: 1n });
    expect(await wrapped.propose(input("a"))).toBe("answer");
    expect(await wrapped.propose(input("b"))).toBe("answer");
    expect(await wrapped.propose(input("a"))).toBeNull();
    expect(seen).toEqual(["a", "b"]);
    now += 3_600_001;
    expect(await wrapped.propose(input("a"))).toBe("answer");
  });
});

describe("hosted error", () => {
  it("carries a code and status", () => {
    const e = new HostedError("x", "y", 418);
    expect([e.code, e.status]).toEqual(["x", 418]);
  });
});
