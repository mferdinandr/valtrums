// FIXTURE-ONLY: registry pages and mappings are synthetic, not entries verified on any network.
import { describe, expect, it } from "vitest";
import { entryHash, type ReferenceEntry } from "../src/audit/reference.js";
import { createLifecycleAuditPass, type LifecycleBattleView } from "../src/audit/lifecycle-pass.js";
import { AuditSubmitter } from "../src/audit/approval.js";
import {
  NearReferenceRegistrySource,
  REFERENCE_REGISTRY_PAGE,
  buildSnapshot,
  resolveAuditReference,
  resolveScoringSubject,
  staticReferenceRegistry,
  type ReferenceRegistrySource,
} from "../src/reference-registry.js";
import { FIXTURE_RESOLVED, NOW, REF_CHAIN, REF_TOKEN, TOKEN, refGoplus, refLp } from "./audit/fixtures.js";

const entry: ReferenceEntry = { chainId: "46630", token: TOKEN, referenceChainId: REF_CHAIN, referenceToken: REF_TOKEN };
const view = (e: ReferenceEntry, hash = entryHash(e)) => ({
  chain_id: e.chainId,
  token_address: e.token,
  reference_chain_id: e.referenceChainId,
  reference_address: e.referenceToken,
  entry_hash: hash,
});
const other = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const asset = { chainId: "46630", token: TOKEN };
const committed = { referenceChainId: REF_CHAIN, referenceAddress: REF_TOKEN };

function transport(pages: (args: { from_index: number; limit: number }) => unknown) {
  const calls: { method: string; args: { from_index: number; limit: number } }[] = [];
  return {
    calls,
    t: {
      view: async <T>(_c: string, method: string, args: object): Promise<T> => {
        const a = args as { from_index: number; limit: number };
        calls.push({ method, args: a });
        return pages(a) as T;
      },
    },
  };
}

describe("reference registry", () => {
  it("entry hash matches the contract's shared test vector and changes with every field", () => {
    const base = entryHash({
      chainId: "46630",
      token: "0x00000000000000000000000000000000000000aa",
      referenceChainId: "4663",
      referenceToken: "0x00000000000000000000000000000000000000bb",
    });
    // Same value as contracts/arena/src/reference_registry.rs `hash_matches_the_agent_encoding...`.
    expect(base).toBe("1a9f51bcd129688ad0cad0dbef76323b7be455592fc583687713d438f82a4366");
    const variants: ReferenceEntry[] = [
      { ...entry, chainId: "46631" },
      { ...entry, token: other(0xcc) },
      { ...entry, referenceChainId: "4664" },
      { ...entry, referenceToken: other(0xdd) },
    ];
    for (const v of variants) expect(entryHash(v)).not.toBe(entryHash(entry));
    expect(entryHash({ ...entry, token: TOKEN.toUpperCase().replace("0X", "0x") })).toBe(entryHash(entry));
  });

  it("accepts a registered entry and resolves it the same way for audit and scoring", async () => {
    const snapshot = await staticReferenceRegistry([entry], "7").load();
    const audit = resolveAuditReference(asset, snapshot, committed);
    expect(audit).toMatchObject({ kind: "mapped", reference: { chainId: REF_CHAIN, token: REF_TOKEN } });
    const scoring = resolveScoringSubject(asset, committed, snapshot);
    expect(scoring).toEqual({
      kind: "reference",
      chainId: REF_CHAIN,
      token: REF_TOKEN,
      registryEntryHash: entryHash(entry),
      registryVersion: "7",
    });
    if (audit.kind !== "mapped" || scoring.kind !== "reference") throw new Error("unreachable");
    expect(audit.reference.registryEntryHash).toBe(scoring.registryEntryHash);
  });

  it("rejects unregistered, conflicting and missing committed mappings for scoring", async () => {
    const empty = await staticReferenceRegistry([]).load();
    expect(resolveScoringSubject(asset, committed, empty)).toMatchObject({ kind: "hold", code: "reference_unregistered" });
    expect(resolveScoringSubject(asset, null, empty)).toEqual({ kind: "direct", chainId: "46630", token: TOKEN });
    const snapshot = await staticReferenceRegistry([entry]).load();
    expect(
      resolveScoringSubject(asset, { referenceChainId: REF_CHAIN, referenceAddress: other(0xdd) }, snapshot),
    ).toMatchObject({ kind: "hold", code: "reference_conflict" });
    expect(resolveScoringSubject(asset, null, snapshot)).toMatchObject({ kind: "hold", code: "reference_mismatch" });
  });

  it("refuses duplicate tokens, a reused reference token and a mismatched contract hash", () => {
    expect(() => buildSnapshot("1", [view(entry), view(entry)])).toThrow(/duplicate/);
    expect(() => buildSnapshot("1", [view(entry), view({ ...entry, token: other(0xcc) })])).toThrow(/two tokens/);
    expect(() => buildSnapshot("1", [view(entry, "00".repeat(32))])).toThrow(/hash/);
    expect(() => buildSnapshot("1", [view({ ...entry, referenceChainId: "1" })])).toThrow(/4663/);
    expect(() => buildSnapshot("x", [view(entry)])).toThrow(/version/);
    expect(buildSnapshot("1", [view(entry)]).hashes.get(`46630:${TOKEN}`)).toBe(entryHash(entry));
  });

  it("pages the arena view and refuses a read that saw a concurrent change or came back short", async () => {
    const entries = Array.from({ length: REFERENCE_REGISTRY_PAGE + 3 }, (_, i) => ({
      ...entry,
      token: other(0x1000 + i),
      referenceToken: other(0x2000 + i),
    }));
    const all = entries.map((e) => view(e));
    const ok = transport(({ from_index, limit }) => ({
      version: "4",
      total: all.length,
      entries: all.slice(from_index, from_index + limit),
    }));
    const snapshot = await new NearReferenceRegistrySource("arena.testnet", ok.t).load();
    expect(snapshot.entries).toHaveLength(all.length);
    expect(snapshot.version).toBe("4");
    expect(ok.calls.map((c) => c.args.from_index)).toEqual([0, REFERENCE_REGISTRY_PAGE]);
    expect(ok.calls.every((c) => c.method === "get_reference_registry")).toBe(true);

    let reads = 0;
    const racing = transport(({ from_index, limit }) => ({
      version: reads++ === 0 ? "4" : "5",
      total: all.length,
      entries: all.slice(from_index, from_index + limit),
    }));
    await expect(new NearReferenceRegistrySource("arena.testnet", racing.t).load()).rejects.toThrow(/changed/);

    const short = transport(({ from_index }) => ({
      version: "4",
      total: 2,
      entries: from_index === 0 ? [all[0]] : [],
    }));
    await expect(new NearReferenceRegistrySource("arena.testnet", short.t).load()).rejects.toThrow(/incomplete/);
    const malformed = transport(() => null);
    await expect(new NearReferenceRegistrySource("arena.testnet", malformed.t).load()).rejects.toThrow(/malformed/);
  });

  it("the audit pass reads the same source once per pass and fails closed when it cannot", async () => {
    const battle: LifecycleBattleView = {
      locked: false,
      communities: [
        {
          chain_id: "46630",
          token_address: TOKEN,
          representation: "aa.token.testnet",
          custody_domain: "vault-1",
          reference_chain_id: REF_CHAIN,
          reference_address: REF_TOKEN,
        },
      ],
    };
    let loads = 0;
    let broken = false;
    const inner = staticReferenceRegistry([entry]);
    const registry: ReferenceRegistrySource = {
      load: async () => {
        loads++;
        if (broken) throw new Error("rpc down");
        return inner.load();
      },
    };
    const calls: unknown[][] = [];
    const queries: { chainId: string; token: string }[] = [];
    const records = new Map();
    const pass = createLifecycleAuditPass({
      source: { count: async () => 1, get: async () => battle },
      refresh: {
        policy: FIXTURE_RESOLVED,
        registry,
        now: () => NOW,
        fetchGoPlus: async (q) => {
          queries.push(q);
          return refGoplus();
        },
        fetchLp: async () => refLp("10001"),
        submitter: new AuditSubmitter("arena.testnet", { call: async (...a: unknown[]) => void calls.push(a) } as never),
        records,
      },
    });
    await pass();
    expect(loads).toBe(1);
    expect(queries).toEqual([{ chainId: REF_CHAIN, token: REF_TOKEN }]);
    expect(calls).toHaveLength(1);

    broken = true;
    records.clear();
    await expect(pass()).rejects.toThrow(/rpc down/);
    expect(calls).toHaveLength(1);
    expect(queries).toHaveLength(1);
  });
});
