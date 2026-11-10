// FIXTURE-ONLY: temp-directory journals; no provider, contract or network.
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ObservationCapacityError, ObservationConflictError, ObservationCorruptError, ObservationJournal, ObservationLockedError,
  ObservationValidationError, loadObservationState,
} from "../../src/observations/journal.js";
import { observationId, observationSchema } from "../../src/observations/schema.js";
import { NS, START_MS, price } from "./fixtures.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "obs-journal-")); });
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("observation schema", () => {
  it("keeps u64 values exact, lowercases addresses and rejects rolling 24h volume / FDV by name", () => {
    const big = "18446744073709551615";
    const ok = observationSchema.parse({ ...price(0, START_MS, "100"), battleId: big, asset: { chainId: "46630", token: `0x${"AB".repeat(20)}` } });
    expect(ok.battleId).toBe(big);
    expect(ok.asset.token).toBe(`0x${"ab".repeat(20)}`);
    expect(observationSchema.safeParse({ ...price(0, START_MS, "100"), battleId: "18446744073709551616" }).success).toBe(false);
    expect(observationSchema.safeParse({ ...price(0, START_MS, "100"), volume24h: "1" }).success).toBe(false);
    expect(observationSchema.safeParse({ ...price(0, START_MS, "100"), fdv: "1" }).success).toBe(false);
    expect(observationSchema.safeParse({ ...price(0, START_MS, "100"), inputs: { kind: "price", price: "100", priceScale: 8, volume24h: "5" } }).success).toBe(false);
  });

  it("binds the mode to its input kind and never treats a missing price as zero", () => {
    expect(observationSchema.safeParse({ ...price(0, START_MS, "100"), mode: "VolumeRatio" }).success).toBe(false);
    expect(observationSchema.safeParse(price(0, START_MS, "0")).success).toBe(false);
    expect(observationSchema.safeParse({ ...price(0, START_MS, "100"), inputs: { kind: "price", price: 100, priceScale: 8 } }).success).toBe(false);
  });

  it("keeps a missing provider time null and the acquisition time separate", () => {
    const o = observationSchema.parse(price(0, null, "100", { acquiredAtMs: "777" }));
    expect(o.observedAtMs).toBeNull();
    expect(o.acquiredAtMs).toBe("777");
  });

  it("identifies content without the acquisition time", () => {
    const a = price(0, START_MS, "100");
    expect(observationId(observationSchema.parse(a))).toBe(observationId(observationSchema.parse({ ...a, acquiredAtMs: "999999" })));
    expect(observationId(observationSchema.parse(a))).not.toBe(observationId(observationSchema.parse({ ...a, inputs: { kind: "price", price: "101", priceScale: 8 } })));
  });
});

describe("durable journal", () => {
  it("persists before it is visible and survives a restart with the same order and head", async () => {
    const j = await ObservationJournal.open(dir);
    const a = price(0, START_MS, "100");
    const b = price(1, START_MS + 1000n, "200");
    expect((await j.append(a)).status).toBe("created");
    await j.append(b);
    const head = j.state.head;
    await j.close();

    const again = await ObservationJournal.open(dir);
    expect(again.state.head).toEqual(head);
    expect(again.state.observations.map((o) => o.observation.community)).toEqual([0, 1]);
    expect(again.health()).toEqual({ status: "healthy", reasons: [] });
    await again.close();
  });

  it("is idempotent for a late retry of the same sample and never double counts", async () => {
    const j = await ObservationJournal.open(dir);
    const a = price(0, START_MS, "100");
    const first = await j.append(a);
    const retry = await j.append({ ...a, acquiredAtMs: "5555555" });
    expect(retry).toEqual({ status: "duplicate", seq: first.seq, id: first.id });
    expect(j.state.observations).toHaveLength(1);
    await j.close();
  });

  it("refuses conflicting content for the same source evidence, keeps the first and degrades", async () => {
    const j = await ObservationJournal.open(dir);
    const a = price(0, START_MS, "100");
    await j.append(a);
    await expect(j.append({ ...a, inputs: { kind: "price", price: "999", priceScale: 8 } })).rejects.toBeInstanceOf(ObservationConflictError);
    expect(j.state.observations).toHaveLength(1);
    expect(j.state.observations[0]?.observation.inputs).toMatchObject({ price: "100" });
    expect(j.health()).toEqual({ status: "degraded", reasons: ["conflicting_source_evidence"] });
    await j.close();
  });

  it("rejects invalid input without writing", async () => {
    const j = await ObservationJournal.open(dir);
    await expect(j.append({ nope: true })).rejects.toBeInstanceOf(ObservationValidationError);
    expect(j.state.head.seq).toBe(0);
    await j.close();
  });

  it("refuses a second writer and never steals the lock", async () => {
    const j = await ObservationJournal.open(dir);
    await expect(ObservationJournal.open(dir)).rejects.toBeInstanceOf(ObservationLockedError);
    await j.close();
    await (await ObservationJournal.open(dir)).close();
  });

  it("fails visibly at capacity and removes nothing", async () => {
    const j = await ObservationJournal.open(dir, { maxRecords: 1 });
    await j.append(price(0, START_MS, "100"));
    await expect(j.append(price(1, START_MS, "100"))).rejects.toBeInstanceOf(ObservationCapacityError);
    expect(j.state.observations).toHaveLength(1);
    expect(j.health().reasons).toContain("capacity_records");
    await j.close();
    const small = await ObservationJournal.open(dir, { maxBytes: 10 });
    await expect(small.append(price(2, START_MS, "100"))).rejects.toBeInstanceOf(ObservationCapacityError);
    await small.close();
  });

  it("discards only a torn final line, says so, and appends cleanly afterwards", async () => {
    const j = await ObservationJournal.open(dir);
    await j.append(price(0, START_MS, "100"));
    await j.close();
    await appendFile(join(dir, "journal.jsonl"), '{"seq":2,"kind":"observation","bo');
    const reader = await loadObservationState(dir);
    expect(reader.tornTail).toBe(true); // a read-only reader reports it and repairs nothing
    expect(await readFile(join(dir, "journal.jsonl"), "utf8")).toContain('"bo');

    const again = await ObservationJournal.open(dir);
    expect(again.health()).toEqual({ status: "degraded", reasons: ["torn_tail_discarded"] });
    expect(again.state.head.seq).toBe(1);
    await again.append(price(1, START_MS, "100"));
    await again.close();
    expect((await loadObservationState(dir)).state.head.seq).toBe(2);
  });

  it("treats an edited, reordered or damaged record as corruption and never resets", async () => {
    const j = await ObservationJournal.open(dir);
    await j.append(price(0, START_MS, "100"));
    await j.append(price(1, START_MS, "100"));
    await j.close();
    const path = join(dir, "journal.jsonl");
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace('"price":"100"', '"price":"101"'));
    await expect(ObservationJournal.open(dir)).rejects.toBeInstanceOf(ObservationCorruptError);
    await expect(loadObservationState(dir)).rejects.toBeInstanceOf(ObservationCorruptError);
    expect(await readFile(path, "utf8")).toContain('"price":"101"'); // untouched, for recovery
    const [l1, l2] = text.trim().split("\n");
    await writeFile(path, `${l2}\n${l1}\n`);
    await expect(loadObservationState(dir)).rejects.toBeInstanceOf(ObservationCorruptError);
    await writeFile(path, "not json\n");
    await expect(loadObservationState(dir)).rejects.toBeInstanceOf(ObservationCorruptError);
  });

  it("detects lost evidence when the manifest is ahead of the journal, and tolerates a lagging manifest", async () => {
    const j = await ObservationJournal.open(dir);
    await j.append(price(0, START_MS, "100"));
    await j.append(price(1, START_MS, "100"));
    await j.close();
    const path = join(dir, "journal.jsonl");
    const text = await readFile(path, "utf8");
    const [first] = text.split("\n");
    await writeFile(path, `${first}\n`);
    await expect(loadObservationState(dir)).rejects.toThrow(/shorter than its manifest/);
    // Restore, then roll the manifest back by one record: the journal is the truth.
    await writeFile(path, text);
    const manifestPath = join(dir, "manifest.json");
    const m = JSON.parse(await readFile(manifestPath, "utf8"));
    const lagging = (await loadObservationState(dir)).state;
    expect(lagging.head.seq).toBe(2);
    await writeFile(manifestPath, JSON.stringify({ ...m, count: 0, headHash: "0".repeat(64) }));
    expect((await loadObservationState(dir)).manifestLagging).toBe(true);
  });

  it("retracts without erasing, bumps the revision and stays idempotent", async () => {
    const j = await ObservationJournal.open(dir);
    const a = await j.append(price(0, START_MS, "100"));
    expect(j.state.revision).toBe(0);
    const r = await j.retract({ namespace: { ...NS }, observationId: a.id, reason: "source block retracted", acquiredAtMs: "1" });
    expect(r.status).toBe("created");
    expect(j.state.revision).toBe(1);
    expect(j.state.isEffective(a.id)).toBe(false);
    expect((await j.retract({ namespace: { ...NS }, observationId: a.id, reason: "again", acquiredAtMs: "2" })).status).toBe("duplicate");
    await expect(j.retract({ namespace: { ...NS }, observationId: "0".repeat(64), reason: "x", acquiredAtMs: "1" })).rejects.toBeInstanceOf(ObservationValidationError);
    await j.close();
    const reopened = await ObservationJournal.open(dir);
    expect(reopened.state.revision).toBe(1);
    expect(reopened.state.byId.has(a.id)).toBe(true); // the evidence is still there
    await reopened.close();
  });
});
