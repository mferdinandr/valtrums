import { describe, expect, it } from "vitest";
import { InMemoryReportArchive } from "../../src/audit/report-archive.js";
import { FixtureStateSource } from "../../src/mcp/account-state.js";
import { FIXTURE_LIMITATION, envelope, freshnessOf } from "../../src/mcp/envelope.js";
import type { ArenaReadSource } from "../../src/mcp/read-source.js";
import { OPEN_SESSION_TOOL, buildMcpServer, handleMcpToolCall } from "../../src/mcp/server.js";
import { AccessDeniedError, READ_TOOLS, READ_TOOL_NAMES, callReadTool } from "../../src/mcp/tools.js";
import { NOW, makeDeps, signRead } from "./fixtures.js";

const READ_METHODS = new Set(["info", "battleCount", "battle", "round", "position", "openPayouts"]);

/** Wraps a source so any access to a non-read member is recorded and fails. */
function guarded(source: ArenaReadSource) {
  const touched: string[] = [];
  const proxy = new Proxy(source, {
    get(target, prop, receiver) {
      const key = String(prop);
      touched.push(key);
      if (!READ_METHODS.has(key) && key !== "then") throw new Error(`non-read access: ${key}`);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { proxy, touched };
}

const argsFor = (name: string, token: string): Record<string, unknown> => {
  if (["inspect_battle", "inspect_round", "inspect_audit", "inspect_endgame"].includes(name)) return { battleId: 2 };
  if (READ_TOOLS.find((t) => t.name === name)?.accountScoped) return { session: token };
  return {};
};

describe("read-only MCP and terminal tools", () => {
  it("exposes only read tools and the read-session exchange, nothing that signs or spends", () => {
    expect(READ_TOOL_NAMES).toEqual([
      "list_battles", "inspect_battle", "inspect_round", "inspect_audit",
      "inspect_positions", "inspect_entitlements", "inspect_payouts", "inspect_escrow",
      "inspect_account_state", "inspect_endgame", "list_recovery_alerts",
    ]);
    const all = [...READ_TOOL_NAMES, OPEN_SESSION_TOOL.name];
    for (const n of all) expect(n).not.toMatch(/submit|sign_tx|send|transfer|deposit|withdraw|approve|grant|reserve|execute/);
  });

  it("every tool only touches read methods of its source and returns network, source, freshness and limitations", async () => {
    const deps = await makeDeps();
    const { proxy, touched } = guarded(deps.arena);
    const archive = new InMemoryReportArchive();
    for (const name of READ_TOOL_NAMES) {
      const out = await callReadTool(name, argsFor(name, deps.aliceToken), {
        ...deps, arena: proxy, audits: { archive, info: { network: "near-testnet", kind: "fixture", name: "archive" } },
        state: new FixtureStateSource("near-testnet", {}),
      });
      expect(out.tool).toBe(name);
      expect(out.network).toBe("near-testnet");
      expect(out.source.kind).toBe("fixture");
      expect(out.limitations).toContain(FIXTURE_LIMITATION);
      expect(out.observedAt).toBe(new Date(NOW).toISOString());
      expect(out.freshness).toBe("fresh");
    }
    expect(touched.every((k) => READ_METHODS.has(k) || k === "then")).toBe(true);
  });

  it("an account id without a session reads that account publicly; an invalid id is refused", async () => {
    const deps = await makeDeps();
    for (const t of READ_TOOLS.filter((x) => x.accountScoped)) {
      await expect(callReadTool(t.name, { accountId: "Not A Valid Id!" }, deps)).rejects.toThrow("not a valid NEAR account id");
    }
    const out = await callReadTool("inspect_positions", { accountId: "bob.testnet" }, deps);
    expect((out.data as { accountId: string }).accountId).toBe("bob.testnet");
  });

  it("account-scoped reads need a session and never return another account's data", async () => {
    const deps = await makeDeps();
    for (const t of READ_TOOLS.filter((x) => x.accountScoped)) {
      await expect(callReadTool(t.name, {}, deps)).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(callReadTool(t.name, { session: "forged.token" }, deps)).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(callReadTool(t.name, { session: deps.aliceToken, accountId: "bob.testnet" }, deps)).rejects.toThrow(
        "can only read its own account",
      );
    }
    const pos = await callReadTool("inspect_positions", { session: deps.aliceToken }, deps);
    expect(pos.data).toMatchObject({ accountId: "alice.testnet" });
    const amounts = (pos.data as { positions: Array<{ amount: string }> }).positions.map((p) => p.amount);
    expect(amounts.sort()).toEqual(["100", "250"]);
    expect(JSON.stringify(pos.data)).not.toContain("999");

    const pay = await callReadTool("inspect_payouts", { session: deps.bobToken, accountId: "bob.testnet" }, deps);
    expect((pay.data as { payouts: Array<{ amount: string; state: string }> }).payouts).toEqual([
      expect.objectContaining({ amount: "8", state: "Broadcast" }),
    ]);
    expect(pay.limitations.join(" ")).toContain("not confirmed until its receipt is verified");
  });

  it("reports escrow without implying a disposition and entitlements as unavailable, not zero", async () => {
    const deps = await makeDeps();
    const escrow = await callReadTool("inspect_escrow", { session: deps.aliceToken }, deps);
    expect(escrow.data).toMatchObject({ escrow: [{ battleId: 2, community: 0, amount: "250", disposition: "undecided" }] });
    expect(escrow.limitations.join(" ")).toContain("use inspect_account_state for the D22 vote status");
    const ent = await callReadTool("inspect_entitlements", { session: deps.aliceToken }, deps);
    expect(ent.data).toMatchObject({ available: false, entitlements: [] });
  });

  it("rejects unknown tools and arguments before reading", async () => {
    const deps = await makeDeps();
    await expect(callReadTool("submit_action", {}, deps)).rejects.toThrow("unknown read tool");
    await expect(callReadTool("inspect_battle", { battleId: 1, privateKey: "x" }, deps)).rejects.toThrow("unknown argument");
    await expect(callReadTool("inspect_battle", { battleId: -1 }, deps)).rejects.toThrow("positive integer");
    await expect(callReadTool("inspect_audit", { battleId: 1 }, deps)).rejects.toThrow("not configured");
  });

  it("serves the same boundary over MCP and refuses errors without leaking internals", async () => {
    const deps = await makeDeps();
    expect(buildMcpServer(deps)).toBeDefined();
    const ok = await handleMcpToolCall("list_battles", { status: "decided" }, deps);
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(ok.content[0]!.text).data.items.map((b: { battleId: number }) => b.battleId)).toEqual([2]);
    const denied = await handleMcpToolCall("inspect_payouts", { session: deps.aliceToken, accountId: "bob.testnet" }, deps);
    expect(denied).toMatchObject({ isError: true });
    const opened = await handleMcpToolCall(OPEN_SESSION_TOOL.name, signRead("carol.testnet"), deps);
    expect(JSON.parse(opened.content[0]!.text).accountId).toBe("carol.testnet");
    const broken = await handleMcpToolCall("inspect_battle", { battleId: 1 }, {
      ...deps, arena: { ...deps.arena, info: deps.arena.info, battle: async () => { throw new Error("https://rpc/?key=secret"); } } as ArenaReadSource,
    });
    expect(broken.content[0]!.text).toBe("read source unavailable");
  });

  it("computes freshness from the observation time and never trusts a future timestamp", () => {
    expect(freshnessOf(null, NOW, 1000)).toBe("unknown");
    expect(freshnessOf(NOW - 500, NOW, 1000)).toBe("fresh");
    expect(freshnessOf(NOW - 5000, NOW, 1000)).toBe("stale");
    expect(freshnessOf(NOW + 5000, NOW, 1000)).toBe("unknown");
    const live = envelope("t", { network: "near-testnet", kind: "live", name: "arena" }, 1, { observedAtMs: NOW, nowMs: NOW, maxAgeMs: 1 });
    expect(live.limitations).not.toContain(FIXTURE_LIMITATION);
  });
});
