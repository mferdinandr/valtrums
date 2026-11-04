import { describe, expect, it, vi } from "vitest";
import { validateIntent } from "./intent";
import { createLlmParser, extractJson, interpretModelReply } from "./llm-parser";
import { createRouteParser } from "./parse-client";

const good = {
  action: "deposit",
  token: "WIF",
  totalUsdc: "50",
  sources: [
    { kind: "credit", amount: "35" },
    { kind: "other_chain", amount: "15", chain: "base" },
  ],
  slippageBps: 100,
};

describe("validateIntent", () => {
  it("accepts a well formed intent", () => {
    const r = validateIntent(good);
    expect(r.ok).toBe(true);
  });

  it("defaults slippage and strips a leading $ from the token", () => {
    const r = validateIntent({ ...good, token: "$WIF", slippageBps: undefined });
    expect(r).toMatchObject({ ok: true, intent: { token: "WIF", slippageBps: 100 } });
  });

  it.each([
    ["not an object", "deposit 50"],
    ["array", []],
    ["null", null],
    ["unknown action", { ...good, action: "withdraw" }],
    ["extra top-level field", { ...good, recipient: "attacker.near" }],
    ["extra source field", { ...good, sources: [{ kind: "credit", amount: "50", to: "x" }] }],
    ["sum mismatch", { ...good, totalUsdc: "51" }],
    ["negative amount", { ...good, totalUsdc: "-50", sources: [{ kind: "credit", amount: "-50" }] }],
    ["zero amount", { ...good, totalUsdc: "0", sources: [{ kind: "credit", amount: "0" }] }],
    ["exponent amount", { ...good, totalUsdc: "1e9", sources: [{ kind: "credit", amount: "1e9" }] }],
    ["too many decimals", { ...good, totalUsdc: "1.1234567", sources: [{ kind: "credit", amount: "1.1234567" }] }],
    ["huge amount", { ...good, totalUsdc: "99999999999", sources: [{ kind: "credit", amount: "99999999999" }] }],
    ["NaN amount", { ...good, totalUsdc: NaN, sources: [{ kind: "credit", amount: NaN }] }],
    ["unknown source kind", { ...good, sources: [{ kind: "treasury", amount: "50" }] }],
    ["other_chain without chain", { ...good, sources: [{ kind: "other_chain", amount: "50" }] }],
    ["unsupported chain", { ...good, sources: [{ kind: "other_chain", amount: "50", chain: "dogechain" }] }],
    ["chain on credit", { ...good, sources: [{ kind: "credit", amount: "50", chain: "base" }] }],
    ["duplicate source", { ...good, totalUsdc: "70", sources: [{ kind: "credit", amount: "35" }, { kind: "credit", amount: "35" }] }],
    ["no sources", { ...good, sources: [] }],
    ["too many sources", { ...good, sources: Array.from({ length: 5 }, () => ({ kind: "credit", amount: "1" })) }],
    ["bad side", { ...good, side: "C" }],
    ["fractional battle", { ...good, battle: 1.5 }],
    ["zero battle", { ...good, battle: 0 }],
    ["token injection", { ...good, token: "WIF; drop table" }],
    ["token too long", { ...good, token: "A".repeat(80) }],
    ["slippage too high", { ...good, slippageBps: 9000 }],
    ["slippage not integer", { ...good, slippageBps: 1.5 }],
  ])("rejects %s", (_name, input) => {
    expect(validateIntent(input).ok).toBe(false);
  });

  it("asks a question when no target is named", () => {
    const { token: _t, ...rest } = good;
    expect(validateIntent(rest)).toMatchObject({ ok: false, clarify: true });
  });
});

describe("model reply handling", () => {
  it("extracts JSON from a fenced reply", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson("not json")).toBeUndefined();
    expect(extractJson("x".repeat(5000))).toBeUndefined();
  });

  it("accepts a valid reply", () => {
    expect(interpretModelReply(JSON.stringify(good)).ok).toBe(true);
  });

  it("turns a clarify reply into a question", () => {
    expect(interpretModelReply('{"clarify":"Which token?"}')).toMatchObject({ ok: false, clarify: true, error: "Which token?" });
  });

  it("rejects hostile or malformed output", () => {
    const hostile = [
      "Sure! Here you go: {}",
      JSON.stringify({ ...good, sources: [{ kind: "credit", amount: "9999" }] }),
      JSON.stringify({ ...good, action: "transfer", recipient: "evil.near" }),
      JSON.stringify({ clarify: "ok", action: "deposit" }),
      "[]",
      "null",
      undefined,
      42,
    ];
    for (const h of hostile) expect(interpretModelReply(h).ok).toBe(false);
  });
});

describe("createLlmParser", () => {
  const reply = (content: string, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }));

  it("calls the chat completions endpoint with the bearer key and validates the output", async () => {
    const fetchImpl = reply(JSON.stringify(good));
    const parser = createLlmParser({ baseUrl: "https://llm.example/v1/", apiKey: "k-test", model: "m", fetchImpl });
    const r = await parser.parse("All-in $WIF with 35 credit and 15 from Base");
    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://llm.example/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k-test");
    const body = JSON.parse(init.body as string);
    expect(body.messages[1]).toEqual({ role: "user", content: "All-in $WIF with 35 credit and 15 from Base" });
  });

  it("rejects invalid model output and HTTP errors without throwing", async () => {
    const bad = createLlmParser({ baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl: reply('{"action":"deposit"}') });
    expect((await bad.parse("deposit 5 to $A")).ok).toBe(false);
    const down = createLlmParser({ baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl: reply("{}", 500) });
    expect(await down.parse("deposit 5 to $A")).toMatchObject({ ok: false });
    const boom = createLlmParser({ baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl: vi.fn(async () => { throw new Error("net"); }) });
    expect(await boom.parse("deposit 5 to $A")).toMatchObject({ ok: false });
  });
});

describe("route parser", () => {
  it("re-validates what the server returns", async () => {
    const evil = vi.fn(async () => new Response(JSON.stringify({ ok: true, intent: { ...good, totalUsdc: "1" } })));
    expect((await createRouteParser(evil as unknown as typeof fetch).parse("x")).ok).toBe(false);
    const fine = vi.fn(async () => new Response(JSON.stringify({ ok: true, intent: good })));
    expect((await createRouteParser(fine as unknown as typeof fetch).parse("x")).ok).toBe(true);
  });
});
