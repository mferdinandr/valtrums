// FIXTURE-ONLY: fake funds, a fake round runner and generated keys. No network.
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Challenges, nep413Digest, SIGN_IN_MESSAGE, SIGN_IN_RECIPIENT, verifyNep413 } from "../../src/hosted/auth.js";
import { decryptSecret, encryptSecret, issueSession, parseKek, readSession } from "../../src/hosted/crypto.js";
import { HostedAgents, HostedError, ModelBudget, type ManagerDeps } from "../../src/hosted/manager.js";
import { AgentStore } from "../../src/hosted/store.js";
import type { ModelProposer } from "../../src/player/model.js";

const KEK = parseKek("11".repeat(32));
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const toB58 = (bytes: Buffer): string => {
  let n = BigInt("0x" + bytes.toString("hex"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  return "1".repeat([...bytes].findIndex((b) => b !== 0)) + out;
};
const wallet = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return { pk: `ed25519:${toB58(Buffer.from(raw))}`, signDigest: (d: Buffer) => sign(null, d, privateKey).toString("base64") };
};

describe("key custody", () => {
  it("round-trips a key and binds it to the account", () => {
    const blob = encryptSecret(KEK, "a1", "ed25519:secret");
    expect(blob).not.toContain("secret");
    expect(decryptSecret(KEK, "a1", blob)).toBe("ed25519:secret");
    expect(() => decryptSecret(KEK, "a2", blob)).toThrow();
    expect(() => decryptSecret(parseKek("22".repeat(32)), "a1", blob)).toThrow();
  });
  it("rejects a malformed KEK", () => {
    expect(() => parseKek("abc")).toThrow(/64 hex/);
    expect(() => parseKek(undefined)).toThrow();
  });
  it("issues sessions that expire and cannot be forged", () => {
    const t = issueSession(KEK, "owner.testnet", 1_000, 5_000);
    expect(readSession(KEK, t, 2_000)).toBe("owner.testnet");
    expect(readSession(KEK, t, 7_000)).toBeNull();
    expect(readSession(KEK, t.replace("owner.testnet", "other.testnet"), 2_000)).toBeNull();
    expect(readSession(parseKek("22".repeat(32)), t, 2_000)).toBeNull();
    expect(readSession(KEK, undefined, 2_000)).toBeNull();
  });
});

describe("owner proof (NEP-413)", () => {
  it("accepts a valid signature once and checks the key belongs to the account", async () => {
    const c = new Challenges(() => 1_000);
    const w = wallet();
    const ch = c.issue("owner.testnet");
    const sig = w.signDigest(nep413Digest(SIGN_IN_MESSAGE, Buffer.from(ch.nonce, "base64"), SIGN_IN_RECIPIENT));
    const proof = { account: "owner.testnet", publicKey: w.pk, signature: sig, nonce: ch.nonce };
    expect(await c.redeem(proof, async () => true)).toBe(true);
    expect(await c.redeem(proof, async () => true)).toBe(false); // spent
  });
  it("rejects a key that is not on the account, a bad signature and an expired nonce", async () => {
    let now = 1_000;
    const c = new Challenges(() => now);
    const w = wallet();
    const a = c.issue("owner.testnet");
    const sigA = w.signDigest(nep413Digest(SIGN_IN_MESSAGE, Buffer.from(a.nonce, "base64"), SIGN_IN_RECIPIENT));
    expect(await c.redeem({ account: "owner.testnet", publicKey: w.pk, signature: sigA, nonce: a.nonce }, async () => false)).toBe(false);
    const b = c.issue("owner.testnet");
    expect(await c.redeem({ account: "owner.testnet", publicKey: w.pk, signature: randomBytes(64).toString("base64"), nonce: b.nonce }, async () => true)).toBe(false);
    const d = c.issue("owner.testnet");
    const sigD = w.signDigest(nep413Digest(SIGN_IN_MESSAGE, Buffer.from(d.nonce, "base64"), SIGN_IN_RECIPIENT));
    now += 10 * 60_000;
    expect(await c.redeem({ account: "owner.testnet", publicKey: w.pk, signature: sigD, nonce: d.nonce }, async () => true)).toBe(false);
  });
  it("does not accept a nonce issued to another account", async () => {
    const c = new Challenges(() => 1_000);
    const w = wallet();
    const ch = c.issue("alice.testnet");
    const sig = w.signDigest(nep413Digest(SIGN_IN_MESSAGE, Buffer.from(ch.nonce, "base64"), SIGN_IN_RECIPIENT));
    expect(await c.redeem({ account: "bob.testnet", publicKey: w.pk, signature: sig, nonce: ch.nonce }, async () => true)).toBe(false);
  });
  it("verifyNep413 is false for garbage input", () => {
    expect(verifyNep413("nope", "x", Buffer.alloc(32))).toBe(false);
  });
});

let counter = 0;
const setup = (over: Partial<ManagerDeps> = {}, limits: Partial<ManagerDeps["limits"]> = {}) => {
  const rounds: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  let killed = false;
  const deps: ManagerDeps = {
    store: new AgentStore(null),
    kek: KEK,
    limits: { maxAgentsPerOwner: 2, maxModelCallsPerAgentHour: 12, maxModelCallsGlobalHour: 3, maxTokenWholePerAgent: 1_000, ...limits },
    killSwitch: () => killed,
    now: () => 1_000,
    newKey: () => {
      counter += 1;
      return { account: `acct${counter}`, publicKey: `ed25519:pk${counter}`, secretKey: `ed25519:sk${counter}` };
    },
    funds: async () => ({ nearYocto: 1n, tokenBase: [100n * 10n ** 18n] }),
    runRound: async (c, key) => void rounds.push(`${c.account}:${key}`),
    log: (e) => void logs.push(e),
    ...over,
  };
  return { m: new HostedAgents(deps), deps, rounds, logs, kill: () => (killed = true) };
};
const mk = (m: HostedAgents, owner = "o.testnet") => m.create(owner, { style: "crowd", sweep: false, keepWhole: 0 });

describe("hosted agents", () => {
  it("never returns the key in the public view or the logs", () => {
    const { m, logs } = setup();
    const a = mk(m);
    expect(JSON.stringify(a)).not.toContain("sk");
    expect(JSON.stringify(m.get("o.testnet", a.account))).not.toContain("sk");
    expect(JSON.stringify(logs)).not.toContain("sk");
  });
  it("limits agents per owner", () => {
    const { m } = setup();
    mk(m);
    mk(m);
    expect(() => mk(m)).toThrow(/at most 2/);
    expect(() => mk(m, "other.testnet")).not.toThrow();
  });
  it("isolates owners: others get not_found for status, start, stop and export", async () => {
    const { m } = setup();
    const a = mk(m);
    for (const f of [() => m.get("x.testnet", a.account), () => m.stop("x.testnet", a.account), () => m.exportKey("x.testnet", a.account)]) {
      expect(f).toThrow(HostedError);
    }
    await expect(m.start("x.testnet", a.account)).rejects.toMatchObject({ code: "not_found" });
  });
  it("exports the key to its owner and records the export", () => {
    const { m, deps } = setup();
    const a = mk(m);
    expect(m.exportKey("o.testnet", a.account).secretKey).toMatch(/^ed25519:sk/);
    expect(deps.store.get(a.account)?.exports).toEqual([1_000]);
  });
  it("refuses to start an unfunded agent and one over the fund cap", async () => {
    const empty = setup({ funds: async () => ({ nearYocto: 0n, tokenBase: [5n] }) });
    await expect(empty.m.start("o.testnet", mk(empty.m).account)).rejects.toMatchObject({ code: "not_funded" });
    const rich = setup({ funds: async () => ({ nearYocto: 1n, tokenBase: [1_001n * 10n ** 18n] }) });
    await expect(rich.m.start("o.testnet", mk(rich.m).account)).rejects.toMatchObject({ code: "over_fund_cap" });
  });
  it("plays only while started, and not after stop", async () => {
    const { m, rounds } = setup();
    const a = mk(m);
    await m.tick();
    expect(rounds).toEqual([]);
    await m.start("o.testnet", a.account);
    await m.tick();
    expect(rounds).toHaveLength(1);
    m.stop("o.testnet", a.account);
    await m.tick();
    expect(rounds).toHaveLength(1);
  });
  it("uses the operator's model cap and the owner as the sweep target", () => {
    const { m, deps } = setup();
    const a = m.create("o.testnet", { style: "underdog", sweep: true, keepWhole: 50 });
    const cfg = m.config(deps.store.get(a.account)!);
    expect(cfg).toMatchObject({ style: "underdog", maxModelCallsPerHour: 12, sweepTo: "o.testnet", keepWhole: 50 });
  });
  it("stops an agent after repeated errors and reports why", async () => {
    const { m } = setup({ runRound: async () => { throw new Error("rpc down"); } });
    const a = mk(m);
    await m.start("o.testnet", a.account);
    for (let i = 0; i < 3; i++) await m.tick();
    const v = m.get("o.testnet", a.account);
    expect(v.running).toBe(false);
    expect(v.lastError).toMatch(/rpc down/);
  });
  it("the kill switch stops every agent before any round and blocks create and start", async () => {
    const { m, rounds, kill } = setup();
    const a = mk(m);
    await m.start("o.testnet", a.account);
    kill();
    await m.tick();
    expect(rounds).toEqual([]);
    expect(m.get("o.testnet", a.account).running).toBe(false);
    expect(() => mk(m)).toThrow(/paused/);
    await expect(m.start("o.testnet", a.account)).rejects.toMatchObject({ code: "kill_switch" });
  });
});

describe("model budget", () => {
  const model: ModelProposer = { propose: async () => "answer" };
  it("caps calls across all agents per hour and counts them per agent", async () => {
    let now = 1_000;
    const seen: string[] = [];
    const wrapped = new ModelBudget(2, () => now, (a) => seen.push(a)).wrap(model);
    const input = (user: string) => ({ strategy: "crowd" as const, user, options: [], maxAmount: 1n });
    expect(await wrapped.propose(input("a"))).toBe("answer");
    expect(await wrapped.propose(input("b"))).toBe("answer");
    expect(await wrapped.propose(input("a"))).toBeNull();
    expect(seen).toEqual(["a", "b"]);
    now += 3_600_001;
    expect(await wrapped.propose(input("a"))).toBe("answer");
  });
});
