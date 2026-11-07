// FIXTURE-ONLY adapter verification; no live GoPlus API is contacted.
import { describe, expect, it } from "vitest";
import { normalizeFlag, normalizeGoPlus, normalizeTax } from "../../src/audit/goplus.js";
import { fetchGoPlusTokenSecurity } from "../../src/audit/goplus-client.js";
import { evaluateCommunity } from "../../src/audit/decision.js";
import { FIXTURE_RESOLVED, NOW, TOKEN, asset, goplus, lp } from "./fixtures.js";

describe("goplus normalization (fixture-only)", () => {
  it('parses "0" as false, "1" as true, absent/odd as unknown', () => {
    expect(normalizeFlag("0").state).toBe("false");
    expect(normalizeFlag("1").state).toBe("true");
    expect(normalizeFlag(undefined).state).toBe("unknown");
    expect(normalizeFlag(null).state).toBe("unknown");
    expect(normalizeFlag("").state).toBe("unknown");
    expect(normalizeFlag(0).state).toBe("unknown");
    expect(normalizeFlag("yes").state).toBe("unknown");
  });

  it("treats tax as exact fractions: 0.05 is 5%, empty is unknown, 1 is entirely taxed", () => {
    expect(normalizeTax("0.05")).toMatchObject({ kind: "known", fraction: "0.05", entirelyTaxed: false });
    expect(normalizeTax("")).toMatchObject({ kind: "unknown" });
    expect(normalizeTax(undefined)).toMatchObject({ kind: "unknown" });
    expect(normalizeTax("1")).toMatchObject({ kind: "known", entirelyTaxed: true });
    expect(normalizeTax("1.0")).toMatchObject({ entirelyTaxed: true });
    expect(normalizeTax("1.5")).toMatchObject({ kind: "malformed" });
    expect(normalizeTax("-0.1")).toMatchObject({ kind: "malformed" });
    expect(normalizeTax("5%")).toMatchObject({ kind: "malformed" });
  });

  it("records ownership separately: empty owner is none, absent is unknown", () => {
    expect(normalizeGoPlus(goplus({ owner_address: "" })).context.owner).toEqual({ kind: "none" });
    expect(normalizeGoPlus(goplus({ owner_address: undefined })).context.owner).toEqual({ kind: "unknown" });
  });

  it("flags unsupported, empty, wrong-token, and non-2xx responses as unusable sources", () => {
    expect(normalizeGoPlus(goplus({}, { code: 2022, result: null })).source.status).toBe("unsupported");
    expect(normalizeGoPlus(goplus({}, { result: {} })).source.status).toBe("empty");
    expect(normalizeGoPlus(goplus({}, { key: "0x00000000000000000000000000000000000000bb" })).source.status).toBe(
      "wrong_source",
    );
    expect(normalizeGoPlus(goplus({}, { httpStatus: 500 })).source.status).toBe("error");
    expect(normalizeGoPlus(goplus({}, { key: TOKEN.toUpperCase().replace("0X", "0x") })).source.status).toBe("ok");
  });

  it("fetch client keeps raw text, sends the token only as a header, and survives failures", async () => {
    let seen: { url: string; auth?: string } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).authorization };
      return new Response('{"code":1,"result":{}}', { status: 200 });
    }) as unknown as typeof fetch;
    const raw = await fetchGoPlusTokenSecurity(
      { chainId: "46630", token: TOKEN },
      { fetchImpl, accessToken: "secret", now: () => new Date("2026-11-07T00:00:00Z") },
    );
    expect(raw.rawText).toBe('{"code":1,"result":{}}');
    expect(seen?.url).toContain("/token_security/46630?contract_addresses=");
    expect(seen?.url).not.toContain("secret");
    expect(seen?.auth).toBe("secret");
    const failing = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const bad = await fetchGoPlusTokenSecurity({ chainId: "46630", token: TOKEN }, { fetchImpl: failing });
    expect(normalizeGoPlus(bad).source.status).toBe("error");
  });

  it("works without any credential: no Authorization header is sent", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response('{"code":1,"message":"OK","result":{}}', { status: 200 });
    }) as unknown as typeof fetch;
    await fetchGoPlusTokenSecurity({ chainId: "4663", token: TOKEN }, { fetchImpl });
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("authorization");
  });

  it("retries a rate limit with bounded backoff and recovers", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const fetchImpl = (async () => {
      n++;
      if (n < 3) return new Response("{}", { status: 429 });
      return new Response(JSON.stringify({ code: 1, result: { [TOKEN]: {} } }), { status: 200 });
    }) as unknown as typeof fetch;
    const raw = await fetchGoPlusTokenSecurity(
      { chainId: "4663", token: TOKEN },
      { fetchImpl, attempts: 3, baseDelayMs: 10, maxDelayMs: 20, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(n).toBe(3);
    expect(sleeps).toEqual([10, 20]);
    expect(raw.httpStatus).toBe(200);
  });

  it("a persistent rate limit (HTTP 429 or provider code) is Pending, never pass or reject", async () => {
    for (const mk of [
      () => new Response("{}", { status: 429 }),
      () => new Response(JSON.stringify({ code: 4029, message: "too many requests" }), { status: 200 }),
    ]) {
      let n = 0;
      const fetchImpl = (async () => (n++, mk())) as unknown as typeof fetch;
      const raw = await fetchGoPlusTokenSecurity(
        { chainId: "4663", token: TOKEN },
        { fetchImpl, attempts: 2, sleep: async () => undefined },
      );
      expect(n).toBe(2);
      expect(normalizeGoPlus(raw).source.status).toBe("rate_limited");
      const rec = evaluateCommunity({
        asset: { ...asset, chainId: "4663", reference: undefined },
        goplus: raw,
        lp: lp("50000", { chainId: "4663" }),
        policy: FIXTURE_RESOLVED,
        now: NOW,
      });
      expect(rec.result).toBe("pending");
      expect(rec.reasons.some((r) => r.code === "source_rate_limited")).toBe(true);
    }
  });
});
