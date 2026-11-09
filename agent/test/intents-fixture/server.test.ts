// FIXTURE: the HTTP front of the 1Click fixture, on loopback with an ephemeral port. No external network.
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FixtureConfigError, FIXTURE_LABEL } from "../../src/intents-fixture/label.js";
import { createFixtureServer, listenFixture } from "../../src/intents-fixture/server.js";
import { fixtureId, recording } from "./helpers.js";

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function start(solverMode?: "complete" | "fail" | "refund") {
  const made = await listenFixture({ network: "testnet", port: 0, logger: { info() {}, warn() {}, error() {} }, ...(solverMode ? { solverMode } : {}) });
  close = () => new Promise((r) => made.server.close(() => r()));
  return `http://127.0.0.1:${(made.server.address() as AddressInfo).port}`;
}

describe("fixture HTTP server", () => {
  it("serves tokens, quote, submit and status over HTTP with the fixture header", async () => {
    const base = await start();
    const tokens = await fetch(`${base}/v0/tokens`);
    expect(tokens.headers.get("x-valtrum-fixture")).toBe("true");
    expect(((await tokens.json()) as unknown[]).length).toBeGreaterThan(0);
    const r = recording.dryQuotes.near_usdc_to_hood_usdg!.request;
    const quote = await fetch(`${base}/v0/quote`, {
      method: "POST",
      body: JSON.stringify({ dry: false, swapType: "EXACT_INPUT", originAsset: fixtureId(String(r.originAsset)), destinationAsset: fixtureId(String(r.destinationAsset)), amount: "10000000", recipient: "0x2222222222222222222222222222222222222222", refundTo: "alice.testnet" }),
    });
    const q = (await quote.json()) as { quote: { depositAddress: string }; valtrumFixture: string };
    expect(q.valtrumFixture).toBe(FIXTURE_LABEL);
    await fetch(`${base}/v0/deposit/submit`, { method: "POST", body: JSON.stringify({ txHash: "t", depositAddress: q.quote.depositAddress }) });
    await fetch(`${base}/v0/status?depositAddress=${q.quote.depositAddress}`);
    const done = (await (await fetch(`${base}/v0/status?depositAddress=${q.quote.depositAddress}`)).json()) as { status: string };
    expect(done.status).toBe("SUCCESS");
  });

  it("switches the solver mode and rejects bad bodies", async () => {
    const base = await start();
    expect((await fetch(`${base}/fixture/solver-mode`, { method: "PUT", body: JSON.stringify({ mode: "refund" }) })).status).toBe(200);
    expect((await fetch(`${base}/fixture/solver-mode`, { method: "PUT", body: JSON.stringify({ mode: "x" }) })).status).toBe(400);
    expect((await fetch(`${base}/v0/quote`, { method: "POST", body: "{" })).status).toBe(400);
  });

  it("refuses to start outside testnet", () => {
    expect(() => createFixtureServer({ network: "mainnet", port: 0 })).toThrow(FixtureConfigError);
  });
});
