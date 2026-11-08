// FIXTURE-ONLY: validates the recorded chain file schema; no network.
import { describe, expect, it } from "vitest";
import { RECORDED_SCHEMA, RecordedBlockSource, RecordedChainError, validateRecordedChain } from "../../src/indexer/recorded-source.js";
import { block, chainFile, created, linked, outcome } from "./fixtures.js";

describe("validateRecordedChain", () => {
  const good = () =>
    chainFile(linked([{ height: "1", outcomes: [outcome("r1", [created(1, "a.testnet")])] }]), { finalizedHeight: "1" });

  it("accepts a well-formed file and round-trips through JSON", () => {
    const parsed = validateRecordedChain(JSON.parse(JSON.stringify(good())));
    expect(parsed.schema).toBe(RECORDED_SCHEMA);
    expect(parsed.blocks).toHaveLength(1);
  });

  it("rejects an unsupported schema", () => {
    expect(() => validateRecordedChain({ ...good(), schema: "nope" })).toThrow(RecordedChainError);
  });

  it("rejects a numeric height instead of rounding it", () => {
    const raw = JSON.parse(JSON.stringify(good()));
    raw.blocks[0].header.height = 1; // a JSON number, not a decimal string
    expect(() => validateRecordedChain(raw)).toThrow(/decimal string/);
  });

  it("rejects a malformed outcome", () => {
    const raw = JSON.parse(JSON.stringify(good()));
    raw.blocks[0].outcomes[0].success = "yes";
    expect(() => validateRecordedChain(raw)).toThrow(RecordedChainError);
  });
});

describe("RecordedBlockSource.blockAt", () => {
  const source = () =>
    new RecordedBlockSource(
      chainFile([block({ height: "1", outcomes: [] }), block({ height: "3", outcomes: [] })], {
        latest: { height: "3", hash: "x" },
        skipped: ["2"],
        incomplete: ["4"],
      }),
    );

  it("classifies present, skipped, incomplete and beyond-head heights", async () => {
    const s = source();
    expect((await s.blockAt("1")).kind).toBe("block");
    expect((await s.blockAt("2")).kind).toBe("skipped");
    expect((await s.blockAt("4")).kind).toBe("incomplete");
    expect((await s.blockAt("9")).kind).toBe("beyond_head");
  });
});
