import { describe, expect, it } from "vitest";
import { parseWithRules } from "./rule-parser";
import type { ParsedIntent } from "./intent";

function ok(prompt: string): ParsedIntent {
  const r = parseWithRules(prompt);
  if (!r.ok) throw new Error(`expected ok for "${prompt}", got: ${r.error}`);
  return r.intent;
}

describe("rule-based parser", () => {
  it("parses the plain deposit example", () => {
    const i = ok("Deposit 50 USDC to $WIF");
    expect(i).toEqual({
      action: "deposit",
      token: "WIF",
      totalUsdc: "50",
      sources: [{ kind: "near_wallet", amount: "50" }],
      slippageBps: 100,
    });
  });

  it("parses the hybrid all-in example", () => {
    const i = ok("All-in $WIF with my remaining 35 USDC credit and add 15 USDC from my Base wallet");
    expect(i.token).toBe("WIF");
    expect(i.totalUsdc).toBe("50");
    expect(i.sources).toEqual([
      { kind: "credit", amount: "35" },
      { kind: "other_chain", amount: "15", chain: "base" },
    ]);
  });

  it("treats a headline total with a credit part as total with remainder from the wallet", () => {
    const i = ok("Deposit 50 USDC to $PEPE using 20 credit");
    expect(i.totalUsdc).toBe("50");
    expect(i.sources).toEqual([
      { kind: "credit", amount: "20" },
      { kind: "near_wallet", amount: "30" },
    ]);
  });

  it("understands Indonesian phrasing", () => {
    const i = ok("Masukkan semua kredit 35 USDC ke $WIF dan tambah 15 USDC dari wallet Base saya");
    expect(i.sources).toEqual([
      { kind: "credit", amount: "35" },
      { kind: "other_chain", amount: "15", chain: "base" },
    ]);
    expect(ok("Setor 25 USDC ke $MOG").totalUsdc).toBe("25");
    expect(ok("Taruh 10 USDC ke tim A battle 3")).toMatchObject({ side: "A", battle: 3, totalUsdc: "10" });
  });

  it("reads battle, side, decimals and slippage", () => {
    const i = ok("bet 12.5 USDC on tribe B in battle #7 with 0.5% slippage");
    expect(i).toMatchObject({ battle: 7, side: "B", totalUsdc: "12.5", slippageBps: 50 });
    expect(ok("Deposit 10 USDC to $WIF slippage 200 bps").slippageBps).toBe(200);
  });

  it("maps chain aliases", () => {
    const i = ok("Deposit 20 USDC to $WIF, 20 USDC from Arbitrum");
    expect(i.sources[0]).toEqual({ kind: "other_chain", amount: "20", chain: "arbitrum" });
    expect(ok("Fund $WIF with 5 USDC from my eth wallet").sources[0]).toMatchObject({ chain: "ethereum" });
  });

  it("does not mistake the battle id or slippage for amounts", () => {
    const i = ok("Deposit 10 USDC to battle 2 tribe A slippage 1%");
    expect(i.totalUsdc).toBe("10");
    expect(i.sources).toHaveLength(1);
  });

  it("asks which token when several are named", () => {
    const r = parseWithRules("Deposit 10 USDC to $WIF or $PEPE");
    expect(r).toMatchObject({ ok: false, clarify: true });
  });

  it("asks for a target when none is given", () => {
    expect(parseWithRules("Deposit 10 USDC")).toMatchObject({ ok: false, clarify: true });
  });

  it("asks for an amount when none is given", () => {
    expect(parseWithRules("Deposit to $WIF")).toMatchObject({ ok: false, clarify: true });
  });

  it("rejects unsupported actions, empty and oversized prompts", () => {
    expect(parseWithRules("what is the weather")).toMatchObject({ ok: false });
    expect(parseWithRules("   ")).toMatchObject({ ok: false });
    expect(parseWithRules("deposit 1 USDC to $WIF " + "x".repeat(600))).toMatchObject({ ok: false });
  });

  it("rejects sources that exceed the stated total", () => {
    expect(parseWithRules("Deposit 10 USDC to $WIF using 20 credit")).toMatchObject({ ok: false });
  });

  it("rejects amounts with more than 6 decimals", () => {
    expect(parseWithRules("Deposit 1.1234567 USDC to $WIF")).toMatchObject({ ok: false });
  });
});
