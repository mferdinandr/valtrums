// FIXTURE-ONLY: fake fetchers and timers. No provider, backend or browser.
import { describe, expect, it, vi } from "vitest";
import { proxyApplicationRead } from "./proxy";
import { createObservationPoller, fetchObservations, ObservationReadError, type ObservationEnvelope, type ObservationItem, type ObservationView } from "./observations";
import type { Namespace } from "./application";

const namespace: Namespace = { deploymentId: "arena-v1", network: "near-testnet", arenaContract: "arena.testnet", protocol: "lifecycle-v2" };
const item = (seq: number, id = `id${seq}`): ObservationItem => ({
  seq: String(seq), id, battleId: "1", roundId: "1", community: 0, mode: "PriceGain", policyHash: "p",
  source: { name: "s", kind: "fixture", pool: null, quote: "USD" }, inputs: { kind: "price", price: "100", priceScale: 8 },
  evidenceHash: `e${seq}`, observedAtMs: String(1000 + seq), acquiredAtMs: "1",
});
const envelope = (items: ObservationItem[], over: { revision?: string; watermark?: string; truncated?: boolean; nextCursor?: string | null; retracted?: string[]; battleId?: string } = {}): ObservationEnvelope => ({
  schemaVersion: "arena-application-v1", namespace,
  provenance: { kind: "market", fetchedAtMs: "1", observedAtMs: null, readModelVersion: "v", watermark: over.watermark ?? String(items.at(-1)?.seq ?? "0"), sourceReferences: [], finality: "unknown", health: "degraded", complete: false, reasons: [] },
  data: { battleId: over.battleId ?? "1", sourceKind: "fixture", sourceKinds: ["fixture"], items, nextCursor: over.nextCursor ?? null, truncated: over.truncated ?? false,
    revision: over.revision ?? "0", retractedSinceCursor: over.retracted ?? [], recorded: null, coverage: null, projection: null },
} as ObservationEnvelope);

function harness(fetcher: Parameters<typeof createObservationPoller>[0]["fetcher"], extra: Partial<Parameters<typeof createObservationPoller>[0]> = {}) {
  const views: ObservationView[] = [];
  let pending: (() => void) | null = null;
  const poller = createObservationPoller({
    fetcher, onView: (v) => views.push(v), intervalMs: 10,
    setTimer: (fn) => { pending = fn; return 1; }, clearTimer: () => { pending = null; }, ...extra,
  });
  const fire = async () => { const fn = pending; pending = null; fn?.(); await flush(); };
  return { poller, views, fire, last: () => views.at(-1)! };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("fetchObservations", () => {
  it("builds a backend query, forwards the abort signal and checks namespace and battle", async () => {
    const controller = new AbortController();
    const doFetch = vi.fn(async (_u: string, _i: RequestInit) => Response.json(envelope([item(1)])));
    const out = await fetchObservations(namespace, "1", { after: "5", community: 1 }, controller.signal, doFetch);
    expect(out.data.items).toHaveLength(1);
    expect(doFetch.mock.calls[0]![0]).toBe("/api/arena/v1/battles/1/observations?deployment=arena-v1&protocol=lifecycle-v2&community=1&after=5&limit=50");
    expect(doFetch.mock.calls[0]![1].signal).toBe(controller.signal);
    await expect(fetchObservations({ ...namespace, arenaContract: "other.testnet" }, "1", {}, controller.signal, doFetch)).rejects.toThrow("namespace");
    await expect(fetchObservations(namespace, "2", {}, controller.signal, doFetch)).rejects.toThrow("another battle");
  });

  it("surfaces a backend outage as an error carrying its code, never as empty data", async () => {
    const doFetch = async () => Response.json({ error: { code: "observations_unavailable", message: "journal corrupt" } }, { status: 503 });
    const err = await fetchObservations(namespace, "1", {}, new AbortController().signal, doFetch).catch((e) => e);
    expect(err).toBeInstanceOf(ObservationReadError);
    expect(err).toMatchObject({ status: 503, code: "observations_unavailable" });
  });
});

describe("observation poller", () => {
  it("loads a bounded snapshot, then polls only deltas after the watermark", async () => {
    const calls: Array<string | undefined> = [];
    const h = harness(async (p) => { calls.push(p.after); return calls.length === 1 ? envelope([item(1), item(2)], { watermark: "2" }) : envelope([item(3)], { watermark: "3" }); });
    h.poller.start(); await flush();
    expect(h.last().items.map((i) => i.seq)).toEqual(["1", "2"]);
    await h.fire();
    expect(calls).toEqual(["0", "2"]);
    expect(h.last().items.map((i) => i.seq)).toEqual(["1", "2", "3"]);
    h.poller.cancel();
  });

  it("marks the snapshot partial when more pages exist than it loads", async () => {
    const h = harness(async (p) => envelope([item(Number(p.after) + 1)], { truncated: true, nextCursor: String(Number(p.after) + 1), watermark: "9" }), { maxSnapshotPages: 2 });
    h.poller.start(); await flush();
    expect(h.last().partial).toBe(true);
    expect(h.last().items).toHaveLength(2);
    h.poller.cancel();
  });

  it("drops everything and reloads on a revision change, and says so", async () => {
    let call = 0;
    const h = harness(async () => {
      call++;
      if (call === 1) return envelope([item(1), item(2)], { revision: "0", watermark: "2" });
      if (call === 2) return envelope([], { revision: "1", watermark: "3", retracted: ["id1"] }); // delta shows a retraction
      return envelope([item(2)], { revision: "1", watermark: "3" }); // fresh snapshot without the retracted sample
    });
    h.poller.start(); await flush();
    await h.fire();
    expect(h.last().items.map((i) => i.id)).toEqual(["id2"]);
    expect(h.last().reconciledAtRevision).toBe("1");
    h.poller.cancel();
  });

  it("never lets a superseded or cancelled response overwrite the current view", async () => {
    const resolvers: Array<(e: ObservationEnvelope) => void> = [];
    const signals: AbortSignal[] = [];
    const h = harness((_p, signal) => { signals.push(signal); return new Promise((r) => resolvers.push(r)); });
    h.poller.start();
    h.poller.setPaused(true); // supersedes the in-flight request
    expect(signals[0]!.aborted).toBe(true);
    resolvers[0]!(envelope([item(99)])); await flush();
    expect(h.views.every((v) => v.items.length === 0)).toBe(true);
    h.poller.setPaused(false); await flush();
    resolvers[1]!(envelope([item(1)])); await flush();
    expect(h.last().items.map((i) => i.seq)).toEqual(["1"]);
    h.poller.cancel();
    resolvers[1]!(envelope([item(2)])); await flush();
    expect(h.last().items.map((i) => i.seq)).toEqual(["1"]);
  });

  it("keeps the last data flagged stale when a refresh fails, and shows unavailable when nothing was ever read", async () => {
    let call = 0;
    const ok = harness(async () => { call++; if (call === 1) return envelope([item(1)]); throw new ObservationReadError("down", 503, null); });
    ok.poller.start(); await flush();
    await ok.fire();
    expect(ok.last()).toMatchObject({ state: "ready", stale: true, error: "down" });
    expect(ok.last().items).toHaveLength(1);
    ok.poller.cancel();
    const never = harness(async () => { throw new ObservationReadError("journal corrupt", 503, "observations_unavailable"); });
    never.poller.start(); await flush();
    expect(never.last()).toMatchObject({ state: "unavailable", items: [], latest: null });
    never.poller.cancel();
  });

  it("does not poll while paused and refreshes immediately on resume", async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return envelope([item(calls)]); });
    h.poller.start(); await flush();
    h.poller.setPaused(true);
    await h.fire(); // no timer is pending while paused
    expect(calls).toBe(1);
    h.poller.setPaused(false); await flush();
    expect(calls).toBe(2);
    h.poller.cancel();
  });
});

describe("gateway route", () => {
  const env = { ARENA_READ_API_URL: "http://localhost:8790" };
  const q = (extra: Record<string, string> = {}) => new URLSearchParams({ deployment: "arena-v1", protocol: "lifecycle-v2", ...extra });
  it("forwards only bounded observation parameters", async () => {
    const fetcher = vi.fn(async (_u: string, _i: RequestInit) => Response.json({ schemaVersion: "arena-application-v1", namespace, provenance: {}, data: {} }));
    const ok = await proxyApplicationRead("battles/1/observations", q({ round: "1", community: "3", after: "10", limit: "50", observedFrom: "0", observedTo: "99" }), env, fetcher);
    expect(ok.status).toBe(200);
    expect(fetcher.mock.calls[0]![0]).toContain("/api/arena/v1/battles/1/observations?");
    const badQueries: Record<string, string>[] = [{ community: "16" }, { round: "x" }, { after: "-1" }, { limit: "51" }, { q: "x" }, { session: "s" }];
    for (const bad of badQueries) {
      expect((await proxyApplicationRead("battles/1/observations", q(bad), env, fetcher)).status).toBe(400);
    }
    expect((await proxyApplicationRead("battles/0/observations", q(), env, fetcher)).status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("session config gateway", () => {
  const env = { ARENA_READ_API_URL: "http://localhost:8790" };
  const upstream = (over: Record<string, unknown> = {}) => async () => Response.json({ schemaVersion: "arena-session-config-v1", readMessage: "read only", sessionRecipient: "valtrum-read", actionRecipient: null, extra: "dropped", ...over });
  it("forwards only the known public fields and refuses malformed upstream answers", async () => {
    const { proxySessionConfig } = await import("./proxy");
    const ok = await proxySessionConfig(env, upstream());
    expect(ok).toEqual({ status: 200, body: { schemaVersion: "arena-session-config-v1", readMessage: "read only", sessionRecipient: "valtrum-read", actionRecipient: null } });
    for (const bad of [{ schemaVersion: "other" }, { sessionRecipient: "" }, { readMessage: 5 }, { actionRecipient: 7 }]) {
      expect((await proxySessionConfig(env, upstream(bad))).status).toBe(503);
    }
    expect((await proxySessionConfig({})).status).toBe(503);
  });
});
