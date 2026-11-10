import { describe, expect, it } from "vitest";
import { claimFaucet, claimMessage, fetchFaucetStatus, formatWait } from "./faucet";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("faucet client", () => {
  it("sends the read session as a bearer token and names tokens only when asked", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const f = async (url: string, init: RequestInit) => { seen.push({ url, init }); return json(200, { live: true, results: [] }); };
    await claimFaucet("tok", ["CASHCAT"], f);
    await claimFaucet("tok", undefined, f);
    expect(seen[0]!.url).toBe("/api/faucet/claim");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(seen[0]!.init.body).toBe(JSON.stringify({ tokens: ["CASHCAT"] }));
    expect(seen[1]!.init.body).toBe("{}");
  });
  it("reads the status and surfaces the service's error text", async () => {
    expect((await fetchFaucetStatus("tok", async () => json(200, { account: "a.testnet", live: false, tokens: [] }))).account).toBe("a.testnet");
    await expect(fetchFaucetStatus("tok", async () => json(401, { error: "a valid read session is required" }))).rejects.toThrow(/read session/);
    await expect(fetchFaucetStatus("tok", async () => new Response("not json", { status: 502 }))).rejects.toThrow(/502/);
  });
  it("formats waits and claim messages", () => {
    expect(formatWait(0)).toBe("now");
    expect(formatWait(-5)).toBe("now");
    expect(formatWait(59 * 60_000)).toBe("59 min");
    expect(formatWait(23 * 3_600_000 + 30 * 60_000)).toBe("23 h 30 min");
    expect(claimMessage({ symbol: "A", status: "cooldown", amount: "1", retryAfterMs: 3_600_000 })).toMatch(/1 h 0 min/);
    expect(claimMessage({ symbol: "A", status: "dry_run", amount: "1" })).toMatch(/nothing was sent/);
    expect(claimMessage({ symbol: "A", status: "error", amount: "1", message: "rpc down" })).toMatch(/rpc down/);
    expect(claimMessage({ symbol: "A", status: "empty", amount: "1" })).toMatch(/run out/);
  });
});
