import { describe, expect, it } from "vitest";
import { buildSearchQuery, fetchBattlePage, fetchReadTool } from "./client";
import { proxyOpenSession, proxyReadTool } from "./proxy";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("read client and proxy", () => {
  it("sends only known, non-empty, trimmed search parameters", () => {
    const p = buildSearchQuery({ q: "  pepe  ", mode: "", status: "open", limit: 10, evil: "1", cursor: undefined });
    expect(p.toString()).toBe("q=pepe&status=open&limit=10");
    expect(buildSearchQuery({ q: "x".repeat(100) }).get("q")).toHaveLength(64);
  });

  it("calls the search endpoint with the abort signal and the session only in a header", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => { seen.push({ url, init }); return ok({ data: { items: [] } }); };
    const controller = new AbortController();
    await fetchBattlePage({ q: "pepe", mode: "PriceGain" }, controller.signal, fetchImpl);
    expect(seen[0]!.url).toBe("/api/arena/tools/list_battles?q=pepe&mode=PriceGain");
    expect(seen[0]!.init.signal).toBe(controller.signal);
    await fetchReadTool("inspect_positions", new URLSearchParams(), { session: "abc.def", fetch: fetchImpl });
    expect(seen[1]!.url).not.toContain("abc.def");
    expect(seen[1]!.init.headers).toEqual({ authorization: "Bearer abc.def" });
    await expect(fetchReadTool("inspect_positions", new URLSearchParams(), { fetch: async () => ok({ error: "missing read session" }, 403) }))
      .rejects.toThrow("missing read session");
  });

  it("proxy forwards only read tools with GET and keeps the session out of the URL", async () => {
    const env = { ARENA_READ_API_URL: "http://127.0.0.1:8790/" };
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => { seen.push({ url, init }); return ok({ data: 1 }); };
    expect(await proxyReadTool("submit_action", new URLSearchParams(), null, env, fetchImpl)).toMatchObject({ status: 404 });
    expect(await proxyReadTool("inspect_positions", new URLSearchParams("session=x"), null, env, fetchImpl)).toMatchObject({ status: 400 });
    expect(await proxyReadTool("list_battles", new URLSearchParams(), null, {}, fetchImpl)).toMatchObject({ status: 503 });
    expect(seen).toHaveLength(0);

    await proxyReadTool("inspect_positions", new URLSearchParams("battleIds=1"), "Bearer abc.def", env, fetchImpl);
    expect(seen[0]!.url).toBe("http://127.0.0.1:8790/tools/inspect_positions?battleIds=1");
    expect(seen[0]!.init.method).toBe("GET");
    expect(seen[0]!.init.headers).toEqual({ authorization: "Bearer abc.def" });
    await proxyReadTool("list_battles", new URLSearchParams(), "Basic secret", env, fetchImpl);
    expect(seen[1]!.init.headers).toEqual({});

    const down = await proxyReadTool("list_battles", new URLSearchParams(), null, env, async () => { throw new Error("ECONNREFUSED http://internal"); });
    expect(down).toEqual({ status: 503, body: { error: "read API unavailable" } });
  });

  it("session proxy posts the signed body and caps its size", async () => {
    const env = { ARENA_READ_API_URL: "https://read.example" };
    const seen: string[] = [];
    const out = await proxyOpenSession("{}", env, async (url, init) => { seen.push(`${init.method} ${url}`); return ok({ token: "t" }); });
    expect(out).toEqual({ status: 200, body: { token: "t" } });
    expect(seen).toEqual(["POST https://read.example/session"]);
    expect(await proxyOpenSession("x".repeat(9000), env)).toMatchObject({ status: 413 });
    expect(await proxyOpenSession("{}", { ARENA_READ_API_URL: "file:///etc" })).toMatchObject({ status: 503 });
  });
});
