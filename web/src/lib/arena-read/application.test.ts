import { describe, expect, it, vi } from "vitest";
import { fetchApplication, type Namespace } from "./application";
import { proxyApplicationRead } from "./proxy";

const namespace: Namespace = { deploymentId: "arena-v1", network: "near-testnet", arenaContract: "arena.testnet", protocol: "lifecycle-v2" };
const query = new URLSearchParams({ deployment: "arena-v1", protocol: "lifecycle-v2", q: "pepe", limit: "20" });
const env = { ARENA_READ_API_URL: "http://localhost:8790" };

describe("versioned read gateway/client", () => {
  it("forwards only configured read routes, params and cancellation; never authorizes actions", async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ schemaVersion: "arena-application-v1", namespace, provenance: {}, data: {} }));
    const controller = new AbortController();
    const result = await proxyApplicationRead("battles", query, env, fetcher, controller.signal);
    expect(result.status).toBe(200);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`http://localhost:8790/api/arena/v1/battles?${query}`);
    controller.abort();
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true);
  });
  it("rejects unknown paths, arbitrary forwarding and invalid limits before fetching", async () => {
    const fetcher = vi.fn();
    for (const path of ["actions", "../actions", "accounts/alice/positions", "https://evil.test"]) {
      expect((await proxyApplicationRead(path, query, env, fetcher)).status).toBe(404);
    }
    for (const extra of [{ upstream: "https://evil.test" }, { session: "secret" }, { limit: "51" }, { limit: "0" }]) {
      const p = new URLSearchParams(query); Object.entries(extra).forEach(([k, v]) => p.set(k, v));
      expect((await proxyApplicationRead("battles", p, env, fetcher)).status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reports missing upstream and outage without demo data or raw errors", async () => {
    expect((await proxyApplicationRead("battles", query, {})).status).toBe(503);
    const out = await proxyApplicationRead("battles", query, env, async () => { throw new Error("credentialed RPC"); });
    expect(out.status).toBe(503); expect(JSON.stringify(out)).not.toContain("credentialed");
  });
  it("requires full namespace match and passes backend query/signal unchanged", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ schemaVersion: "arena-application-v1", namespace, provenance: { kind: "fixture" }, data: { items: [] } }));
    await fetchApplication(namespace, "battles", { q: "pepe", limit: 20 }, controller.signal, fetcher);
    expect(fetcher.mock.calls[0]![0]).toContain("deployment=arena-v1&protocol=lifecycle-v2&q=pepe&limit=20");
    expect(fetcher.mock.calls[0]![1].signal).toBe(controller.signal);
    await expect(fetchApplication({ ...namespace, arenaContract: "other.testnet" }, "battles", {}, controller.signal, fetcher)).rejects.toThrow("namespace");
  });
});
