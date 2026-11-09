// FIXTURE-ONLY: writes recorded chain files to a temp dir and runs the read-only CLI end to end.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runIndexerCli, type CliIo } from "../../src/indexer/cli.js";
import { auditUpdated, chainFile, created, deposit, emitLog, linked, outcome } from "./fixtures.js";

let dir: string;
let statePath: string;
let chainPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "indexer-cli-"));
  statePath = join(dir, "state");
  chainPath = join(dir, "chain.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

const baseChain = () =>
  chainFile(
    linked([
      { height: "1", outcomes: [outcome("r1", [created(1, "alice.testnet")])] },
      { height: "2", outcomes: [outcome("r2", [auditUpdated(1, 0, "pass")])] },
      { height: "3", outcomes: [outcome("r3", [deposit(1, 0, "bob.testnet", "100")])] },
    ]),
    { finalizedHeight: "2" },
  );

const writeChain = (chain: unknown) => writeFile(chainPath, JSON.stringify(chain), "utf8");
const parseOut = (out: string[]) => JSON.parse(out.join("\n"));

describe("indexer CLI", () => {
  it("imports, reports status and replays the same projection digest", async () => {
    await writeChain(baseChain());

    const imp = capture();
    expect(await runIndexerCli(["import", "--chain", chainPath, "--dir", statePath], {}, imp.io)).toBe(0);
    const importResult = parseOut(imp.out);
    expect(importResult.status).toBe("healthy");
    expect(importResult.processedHead.height).toBe("3");
    expect(importResult.battles).toBe(1);
    expect(imp.err).toHaveLength(0); // machine output is not mixed with diagnostics

    const stat = capture();
    await runIndexerCli(["status", "--dir", statePath], {}, stat.io);
    expect(parseOut(stat.out)).toMatchObject({ processedHead: { height: "3" }, finalizedHead: { height: "2" }, journal: 3 });

    const rep = capture();
    await runIndexerCli(["replay", "--dir", statePath], {}, rep.io);
    expect(parseOut(rep.out).digest).toBe(importResult.digest); // replay matches the ingested projection
  });

  it("is idempotent across a restart (second import does not change the projection)", async () => {
    await writeChain(baseChain());
    const first = capture();
    await runIndexerCli(["import", "--chain", chainPath, "--dir", statePath], {}, first.io);
    const digest1 = parseOut(first.out).digest;

    const second = capture();
    await runIndexerCli(["import", "--chain", chainPath, "--dir", statePath], {}, second.io);
    expect(parseOut(second.out).digest).toBe(digest1);
  });

  it("reconciles a reorged chain on re-import and reflects the canonical branch", async () => {
    await writeChain(baseChain());
    const first = capture();
    await runIndexerCli(["import", "--chain", chainPath, "--dir", statePath], {}, first.io);
    const digest1 = parseOut(first.out).digest;

    // Replace block 3 with a forked block (new hash, different deposit); heights 1-2 unchanged.
    const forked = chainFile(
      linked([
        { height: "1", outcomes: [outcome("r1", [created(1, "alice.testnet")])] },
        { height: "2", outcomes: [outcome("r2", [auditUpdated(1, 0, "pass")])] },
        { height: "3", hash: "blk3b", outcomes: [outcome("r3b", [deposit(1, 0, "bob.testnet", "999")])] },
      ]),
      { finalizedHeight: "3" },
    );
    await writeChain(forked);
    const second = capture();
    expect(await runIndexerCli(["import", "--chain", chainPath, "--dir", statePath], {}, second.io)).toBe(0);
    const result = parseOut(second.out);
    expect(result.status).toBe("healthy");
    expect(result.digest).not.toBe(digest1); // canonical branch changed

    const proj = capture();
    await runIndexerCli(["projection", "--dir", statePath], {}, proj.io);
    const battle = parseOut(proj.out).battles[`${forked.identity.network}|arena.testnet|1`];
    expect(battle.creditedByCommunity["0"]).toBe("999");
  });

  it("exits non-zero when the imported chain leaves the indexer degraded", async () => {
    const degrading = chainFile(
      linked([
        { height: "1", outcomes: [outcome("r1", [created(1, "alice.testnet")])] },
        // An allowlisted emitter emits an event this indexer version does not model: a coverage gap.
        { height: "2", outcomes: [outcome("r2", [emitLog("backing_updated", { battle_id: 1 })])] },
      ]),
      { finalizedHeight: "2" },
    );
    await writeChain(degrading);
    const imp = capture();
    expect(await runIndexerCli(["import", "--chain", chainPath, "--dir", statePath], {}, imp.io)).toBe(3);
    expect(parseOut(imp.out).status).toBe("degraded");

    const stat = capture();
    expect(await runIndexerCli(["status", "--dir", statePath], {}, stat.io)).toBe(3);
    expect(parseOut(stat.out).status).toBe("degraded");
  });

  it("errors clearly on a missing chain or state", async () => {
    const a = capture();
    expect(await runIndexerCli(["import", "--chain", join(dir, "nope.json"), "--dir", statePath], {}, a.io)).toBe(1);
    expect(a.err.join("\n")).toContain("cannot read recorded chain");

    const b = capture();
    await runIndexerCli(["status", "--dir", join(dir, "empty")], {}, b.io);
    expect(parseOut(b.out).state).toBe("missing");
  });
});
