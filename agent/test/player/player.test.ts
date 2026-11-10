// FIXTURE-ONLY: synthetic accounts and responses. Nothing here touches a chain or a model.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { delegateGrantsOf, keyFor, loadPlayerAgents, parsePlayerAgents } from "../../src/player/config.js";
import { buildPrompt, createModelProposer } from "../../src/player/model.js";
import { PlayerState, stateKey } from "../../src/player/state.js";
import { decide, maxAmount, type Option } from "../../src/player/strategy.js";

const LOCAL = "11".repeat(32);
const agentJson = (over: Record<string, unknown> = {}) => ({
  delegate: "agent.testnet", user: "alice.testnet", localId: LOCAL, strategy: "crowd", keyEnv: "PLAYER_KEY_A", ...over,
});

describe("strategies", () => {
  const options: Option[] = [
    { battleId: 2, community: 0, vault: 100n },
    { battleId: 2, community: 1, vault: 300n },
    { battleId: 1, community: 1, vault: 300n },
  ];
  it("crowd backs the largest vault and underdog the smallest, deterministically", () => {
    expect(decide("crowd", options, 100n, 500n, 2_500)).toMatchObject({ battleId: 1, community: 1, amount: "100" });
    expect(decide("underdog", options, 100n, 500n, 2_500)).toMatchObject({ battleId: 2, community: 0 });
    expect(decide("crowd", [...options].reverse(), 100n, 500n, 2_500)).toEqual(decide("crowd", options, 100n, 500n, 2_500));
  });
  it("never spends more than the per-action cap or the share of what is left", () => {
    expect(maxAmount(100n, 500n, 2_500)).toBe(100n);
    expect(maxAmount(1_000n, 500n, 2_500)).toBe(125n);
    expect(maxAmount(1_000n, 3n, 1)).toBe(1n);
    expect(maxAmount(1_000n, 0n, 2_500)).toBe(0n);
    expect(maxAmount(0n, 500n, 2_500)).toBe(0n);
    expect(maxAmount(100n, 500n, 0)).toBe(0n);
    expect(maxAmount(100n, 500n, 10_001)).toBe(0n);
  });
  it("returns nothing when there is nothing to back or nothing to spend", () => {
    expect(decide("crowd", [], 100n, 500n, 2_500)).toBeNull();
    expect(decide("crowd", options, 100n, 0n, 2_500)).toBeNull();
  });
});

describe("player state", () => {
  it("remembers what was done across restarts and writes atomically", () => {
    const path = join(mkdtempSync(join(tmpdir(), "player-")), "state.json");
    const a = new PlayerState(path);
    const key = stateKey("alice.testnet", LOCAL, 1, 0);
    a.markActed(key, { at: 1_000, actionId: "a1", txHash: "h", status: "confirmed" });
    a.markBlocked("k2", 9_000);
    const b = new PlayerState(path);
    expect(b.has(key)).toBe(true);
    expect(b.actedSince(500)).toBe(1);
    expect(b.actedSince(2_000)).toBe(0);
    expect(b.isBlocked("k2", 8_000)).toBe(true);
    expect(b.isBlocked("k2", 9_000)).toBe(false);
  });
  it("counts failures, resets them on success, and refuses a malformed file instead of resetting it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "player-")), "state.json");
    const s = new PlayerState(path);
    expect(s.recordFailure()).toBe(1);
    expect(s.recordFailure()).toBe(2);
    s.markActed("k", { at: 1, actionId: "a", txHash: null, status: "x" });
    expect(s.failures).toBe(0);
    writeFileSync(path, "{not json");
    expect(() => new PlayerState(path)).toThrow();
    writeFileSync(path, JSON.stringify({ version: 2 }));
    expect(() => new PlayerState(path)).toThrow(/malformed/);
    expect(readFileSync(path, "utf8")).toContain("version");
  });
  it("works without a file", () => {
    const s = new PlayerState(null);
    s.markActed("k", { at: 1, actionId: "a", txHash: null, status: "x" });
    expect(s.has("k")).toBe(true);
  });
});

describe("player agent config", () => {
  it("applies conservative defaults", () => {
    const [a] = parsePlayerAgents({ agents: [agentJson()] });
    expect(a).toMatchObject({ mode: "rule", fractionBps: 2_500, maxPerHour: 6, maxFailures: 3, intervalSecs: 60, scanBattles: 20, mappingVersion: "1" });
  });
  it("refuses unsafe or malformed agents with a specific reason", () => {
    const bad = (over: Record<string, unknown>) => () => parsePlayerAgents({ agents: [agentJson(over)] });
    expect(bad({ delegate: "alice.testnet" })).toThrow(/must differ/);
    expect(bad({ localId: "zz" })).toThrow(/32 bytes/);
    expect(bad({ strategy: "yolo" })).toThrow(/crowd or underdog/);
    expect(bad({ keyEnv: "ed25519:abc" })).toThrow(/never go in this file/);
    expect(bad({ keyEnv: undefined })).toThrow(/keyEnv/);
    expect(bad({ mode: "magic" })).toThrow(/rule or model/);
    expect(bad({ fractionBps: 0 })).toThrow(/fractionBps/);
    expect(bad({ maxPerHour: 1000 })).toThrow(/maxPerHour/);
    expect(bad({ intervalSecs: 1 })).toThrow(/intervalSecs/);
    expect(() => parsePlayerAgents({ agents: [] })).toThrow(/non-empty/);
    expect(() => parsePlayerAgents({ agents: [agentJson(), agentJson()] })).toThrow(/repeats/);
  });
  it("loads a file and reports an unreadable one without leaking its content", () => {
    expect(loadPlayerAgents("x", () => JSON.stringify({ agents: [agentJson()] }))).toHaveLength(1);
    expect(() => loadPlayerAgents("x", () => "{ secret ed25519:AAAA")).toThrow("player agent config is not readable JSON");
  });
  it("builds the delegate grants from operator config and reads keys only from the environment", () => {
    const agents = parsePlayerAgents({ agents: [agentJson({ mappingVersion: 2 })] });
    expect(delegateGrantsOf(agents)).toEqual({ "agent.testnet": [{ user: "alice.testnet", localId: LOCAL, mappingVersion: "2" }] });
    expect(keyFor(agents[0]!, { PLAYER_KEY_A: "ed25519:SECRETVALUE" })).toBe("ed25519:SECRETVALUE");
    expect(() => keyFor(agents[0]!, {})).toThrow(/PLAYER_KEY_A/);
    expect(() => keyFor(agents[0]!, { PLAYER_KEY_A: "SECRETVALUE" })).toThrow(/ed25519/);
    try {
      keyFor(agents[0]!, { PLAYER_KEY_A: "SECRETVALUE" });
    } catch (e) {
      expect(String(e)).not.toContain("SECRETVALUE");
    }
  });
});

describe("model proposer", () => {
  const input = { strategy: "underdog" as const, user: "alice.testnet", options: [{ battleId: 1, community: 0, vault: 5n }], maxAmount: 10n };
  it("puts only numbers and ids in the prompt, never token text", () => {
    const p = buildPrompt(input);
    expect(p.user).toContain("battleId=1 community=0 vault=5");
    expect(p.system).toMatch(/exactly one JSON object/);
  });
  it("returns the raw answer and sends the key only in the authorization header", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const m = createModelProposer({ apiKey: "k-secret", model: "m", fetchImpl: async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"deposit"}' } }] }), { status: 200 });
    } });
    expect(await m.propose(input)).toBe('{"action":"deposit"}');
    expect(seen!.url).toBe("https://cloud-api.near.ai/v1/chat/completions");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer k-secret");
    expect(String(seen!.init.body)).not.toContain("k-secret");
  });
  it("gives null, never an exception, on an error, a bad body or an outage", async () => {
    const make = (fetchImpl: Parameters<typeof createModelProposer>[0]["fetchImpl"]) => createModelProposer({ apiKey: "k", model: "m", fetchImpl });
    expect(await make(async () => new Response("no", { status: 500 })).propose(input)).toBeNull();
    expect(await make(async () => new Response("{}", { status: 200 })).propose(input)).toBeNull();
    expect(await make(async () => new Response(JSON.stringify({ choices: [{ message: { content: "  " } }] }), { status: 200 })).propose(input)).toBeNull();
    expect(await make(async () => { throw new Error("offline"); }).propose(input)).toBeNull();
  });
});
