// FIXTURE tests pinned to RECORDED mainnet responses (no network). The recording is a summary kept in
// docs/evidence, not a raw capture: fields it lacks are checked against the official OpenAPI list below.
import { describe, expect, it } from "vitest";
import { FIXTURE_ASSETS } from "../../src/intents-fixture/assets.js";
import { driftProblems, formatOf } from "../../src/intents-fixture/drift.js";
import { FIXTURE_HEADER, FIXTURE_LABEL } from "../../src/intents-fixture/label.js";
import { fixtureId, makeFixture, recording } from "./helpers.js";

const quoteBody = (key: string, over: Record<string, unknown> = {}) => {
  const r = recording.dryQuotes[key]!.request;
  return {
    dry: true,
    swapType: r.swapType,
    originAsset: fixtureId(String(r.originAsset)),
    destinationAsset: fixtureId(String(r.destinationAsset)),
    amount: r.amount,
    slippageTolerance: 100,
    recipient: "0x1111111111111111111111111111111111111111",
    refundTo: "alice.testnet",
    depositType: r.depositType,
    recipientType: r.recipientType,
    ...over,
  };
};

describe("token discovery golden", () => {
  const { call } = makeFixture();
  const tokens = call("GET", "/v0/tokens").body as Record<string, unknown>[];

  it("lists the same Robinhood assets with the recorded symbols, decimals and field formats", () => {
    const hood = tokens.filter((t) => t.blockchain === "hood");
    expect(hood).toHaveLength(recording.blockchains.hood ?? -1);
    for (const rec of recording.robinhoodMainnetAssets) {
      const mine = hood.find((t) => t.symbol === rec.symbol);
      expect(mine, rec.symbol).toBeDefined();
      expect(driftProblems(rec as unknown as Record<string, unknown>, mine!)).toEqual([]);
      expect(mine!.decimals).toBe(rec.decimals);
      // The mock's id is NOT the mainnet id: it must be a different, fixture-shaped nep141 id.
      expect(mine!.assetId).not.toBe(rec.assetId);
      expect(formatOf(mine!.assetId)).toBe("nep141-asset-id");
      expect(rec.contractAddress === null).toBe(mine!.contractAddress === undefined);
    }
  });

  it("carries every required TokenResponse field from the official OpenAPI", () => {
    for (const t of tokens) {
      expect(typeof t.assetId).toBe("string");
      expect(typeof t.decimals).toBe("number");
      expect(typeof t.blockchain).toBe("string");
      expect(typeof t.symbol).toBe("string");
      expect(typeof t.price).toBe("number");
      expect(formatOf(t.priceUpdatedAt)).toBe("iso-time");
    }
    expect(tokens.every((t) => !String(t.assetId).endsWith(".omft.near"))).toBe(true);
  });

  it("is labelled as a fixture by header and lists no real mainnet asset id", () => {
    expect(call("GET", "/v0/tokens").headers[FIXTURE_HEADER]).toBe("true");
    const ids = new Set(FIXTURE_ASSETS.map((a) => a.mainnetAssetId));
    expect(tokens.some((t) => ids.has(String(t.assetId)))).toBe(false);
  });
});

describe("dry quote golden", () => {
  for (const key of ["near_usdc_to_hood_cashcat", "near_usdc_to_hood_usdg", "near_usdc_to_hood_eth"]) {
    it(`${key} reproduces the recorded amounts, estimate and formats`, () => {
      const { call } = makeFixture();
      const res = call("POST", "/v0/quote", quoteBody(key));
      expect(res.status).toBe(200);
      const rec = recording.dryQuotes[key]!;
      const body = res.body as { quote: Record<string, unknown> };
      expect(driftProblems({ amountIn: rec.amountIn, amountOut: rec.amountOut, minAmountOut: rec.minAmountOut, timeEstimate: rec.timeEstimate, depositAddress: null }, body.quote)).toEqual([]);
      expect(body.quote.amountIn).toBe(rec.amountIn);
      expect(body.quote.amountOut).toBe(rec.amountOut);
      expect(body.quote.minAmountOut).toBe(rec.minAmountOut);
      expect(body.quote.timeEstimate).toBe(rec.timeEstimate);
      // A dry quote has no deposit address, deadline or inactivity time.
      for (const k of ["depositAddress", "deadline", "timeWhenInactive"]) expect(k in body.quote).toBe(false);
    });
  }

  it("has every required QuoteResponse and Quote field from the official OpenAPI, plus only the fixture label", () => {
    const { call } = makeFixture();
    const body = call("POST", "/v0/quote", quoteBody("near_usdc_to_hood_usdg")).body as Record<string, unknown>;
    for (const k of ["correlationId", "timestamp", "signature", "quoteRequest", "quote"]) expect(body, k).toHaveProperty(k);
    const quote = body.quote as Record<string, unknown>;
    for (const k of ["amountIn", "amountInFormatted", "amountInUsd", "minAmountIn", "amountOut", "amountOutFormatted", "amountOutUsd", "minAmountOut", "timeEstimate"]) {
      expect(quote, k).toHaveProperty(k);
    }
    expect(Object.keys(body).sort()).toEqual(["correlationId", "quote", "quoteRequest", "signature", "timestamp", "valtrumFixture"]);
    expect(body.valtrumFixture).toBe(FIXTURE_LABEL);
    expect((body.quoteRequest as Record<string, unknown>).deadline).toBeDefined();
  });

  it("refuses the burn sink as recipient like the real API did (recorded: 'recipient is not valid')", () => {
    const { call } = makeFixture();
    const res = call("POST", "/v0/quote", quoteBody("near_usdc_to_hood_usdg", { recipient: "0x000000000000000000000000000000000000dEaD" }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "recipient is not valid" });
  });
});

describe("drift detection", () => {
  const recorded = recording.robinhoodMainnetAssets[0]! as unknown as Record<string, unknown>;
  const { call } = makeFixture();
  const mine = (call("GET", "/v0/tokens").body as Record<string, unknown>[]).find((t) => t.symbol === recorded.symbol)!;

  it("fails when a field is renamed, retyped, reformatted or its recorded absence changes", () => {
    const { assetId: _a, ...renamed } = mine;
    expect(driftProblems(recorded, { ...renamed, asset_id: mine.assetId })).toContain("assetId: missing in fixture");
    expect(driftProblems(recorded, { ...mine, decimals: "6" })).toContain("decimals: type number expected, got string");
    expect(driftProblems(recorded, { ...mine, contractAddress: "not-an-address" })).toContain("contractAddress: format evm-address expected, got text");
    expect(driftProblems({ ...recorded, depositAddress: null }, { ...mine, depositAddress: "x" })).toContain("depositAddress: recorded as null/absent, fixture has a value");
  });

  it("fails when the quote amounts stop being integer strings", () => {
    const rec = recording.dryQuotes.near_usdc_to_hood_usdg!;
    expect(driftProblems({ amountOut: rec.amountOut }, { amountOut: "9.9" })).toEqual(["amountOut: format digits expected, got decimal"]);
    expect(driftProblems({ amountOut: rec.amountOut }, { amountOut: 9904355 })).toEqual(["amountOut: type string expected, got number"]);
  });

  it("the recording itself lists no testnet asset, which is why the fixture exists", () => {
    expect(recording.testnetAssets).toEqual([]);
  });
});
