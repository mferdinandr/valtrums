// FIXTURE: the intents-fixture funding route at the action boundary. No Intents integration is claimed.
import { describe, expect, it } from "vitest";
import { FixtureConfigError, FIXTURE_LABEL, assertFixtureAllowed } from "../../src/intents-fixture/label.js";
import { SUPPORTED_FUNDING_ROUTES } from "../../src/mcp/actions/preview.js";
import { ActionService } from "../../src/mcp/actions/service.js";
import { ActionStore } from "../../src/mcp/actions/store.js";
import { callActionTool } from "../../src/mcp/actions/tools.js";
import { FixtureActionReadSource } from "../../src/mcp/actions/source.js";
import { depsFromEnv } from "../../src/mcp/cli.js";
import { NOW, RECIPIENT, makeSessions, makeSource, signRead } from "../mcp/fixtures.js";
import { baseCtx, deposit, makeActions, signFor } from "./harness.js";

describe("intents-fixture route acceptance", () => {
  it("is refused by default: the supported routes stay direct only", async () => {
    expect([...SUPPORTED_FUNDING_ROUTES]).toEqual(["direct"]);
    const { service } = makeActions();
    await expect(service.preview("alice.testnet", deposit({ route: "intents-fixture" }))).rejects.toMatchObject({ code: "unsupported_route" });
  });

  it("is accepted on a testnet configuration that enables it, and still refuses every other route", async () => {
    const { service } = makeActions({ ...baseCtx, intentsFixture: true });
    const r = await service.preview("alice.testnet", deposit({ route: "intents-fixture" }));
    expect(r.preview.binding).toMatchObject({ route: "intents-fixture", fixture: true, fixtureLabel: FIXTURE_LABEL });
    expect(r.preview.limitations).toContain(FIXTURE_LABEL);
    for (const route of ["intents", "bridge", "oneclick", "Intents-Fixture", "intents-fixture "]) {
      await expect(service.preview("alice.testnet", deposit({ route }))).rejects.toMatchObject({ code: "unsupported_route" });
    }
    // The direct deposit is unchanged and unlabelled.
    const direct = await service.preview("alice.testnet", deposit());
    expect(direct.preview.binding).toMatchObject({ route: "direct" });
    expect(direct.preview.binding).not.toHaveProperty("fixture");
  });

  it("cannot be enabled outside testnet: the service refuses to start", () => {
    const base = { source: new FixtureActionReadSource("near-mainnet", { battles: new Map(), positions: new Map(), balances: new Map(), entitlements: new Map(), grants: new Map(), budgets: new Map() }), store: new ActionStore(null), recipient: RECIPIENT, receipts: { check: async () => ({ status: "pending" as const, reason: "" }) }, verify: async () => true };
    for (const network of ["near-mainnet", "mainnet", ""]) {
      expect(() => new ActionService({ ...base, ctx: { ...baseCtx, network, intentsFixture: true } })).toThrow(FixtureConfigError);
    }
    expect(() => assertFixtureAllowed("testnet")).not.toThrow();
    expect(() => assertFixtureAllowed(undefined)).toThrow(/testnet/);
  });

  it("the service environment flag works on testnet and refuses mainnet", () => {
    const env = { READ_SESSION_SECRET: "ab".repeat(32), ARENA_CONTRACT_ID: "arena.testnet", READ_SESSION_RECIPIENT: "valtrum-read", ACTION_STORE_PATH: "/nonexistent/actions.json", INTENTS_FIXTURE: "1" };
    expect(() => depsFromEnv({ ...env, NEAR_NETWORK: "testnet" })).not.toThrow();
    expect(() => depsFromEnv({ ...env, NEAR_NETWORK: "mainnet" })).toThrow(FixtureConfigError);
  });

  it("is not available through a grant", async () => {
    const { service } = makeActions({ ...baseCtx, intentsFixture: true });
    await expect(
      service.preview("agent.testnet", deposit({ route: "intents-fixture", grant: { user: "alice.testnet", localId: "11".repeat(32), mappingVersion: "1" } })),
    ).rejects.toMatchObject({ code: "unsupported_route" });
  });

  it("rejects an old fixture preview at prepare once the configuration no longer enables the route", async () => {
    const on = makeActions({ ...baseCtx, intentsFixture: true });
    const r = await on.service.preview("alice.testnet", deposit({ route: "intents-fixture" }));
    await on.service.authorize(r.actionId, "alice.testnet", signFor(r.previewHash));
    // Same store, but the context now has the fixture off.
    const off = new ActionService({ ...(on.service as unknown as { deps: ConstructorParameters<typeof ActionService>[0] }).deps, ctx: baseCtx });
    await expect(off.prepare(r.actionId, "alice.testnet")).rejects.toMatchObject({ code: "unsupported_route" });
  });

  it("labels the route in the status surface (attribution) and in the tool envelope", async () => {
    const { service } = makeActions({ ...baseCtx, intentsFixture: true });
    const sessions = makeSessions();
    const token = (await sessions.open(signRead("alice.testnet"))).token;
    const deps = { arena: makeSource(), sessions, now: () => NOW, actions: service };
    const preview = (await callActionTool("preview_action", { session: token, request: deposit({ route: "intents-fixture" }) }, deps)).data as { actionId: string };
    const status = await callActionTool("action_status", { session: token, actionId: preview.actionId }, deps);
    expect((status.data as { attribution: { route: unknown } }).attribution.route).toEqual({ name: "intents-fixture", fixture: true, label: FIXTURE_LABEL });
    expect(status.limitations).toContain(FIXTURE_LABEL);
    const direct = (await callActionTool("preview_action", { session: token, request: deposit({ amount: "5" }) }, deps)).data as { actionId: string };
    const dStatus = await callActionTool("action_status", { session: token, actionId: direct.actionId }, deps);
    expect((dStatus.data as { attribution: { route: unknown } }).attribution.route).toEqual({ name: "direct", fixture: false, label: null });
  });
});
