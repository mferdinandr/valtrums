import { describe, expect, it } from "vitest";
import { loadConfig, resolveAgentKey } from "../src/config.js";

const KEY = "ed25519:TOPSECRETVALUE";
const base = { ARENA_CONTRACT_ID: "arena.testnet", AGENT_ACCOUNT_ID: "agent.testnet" };

describe("resolveAgentKey", () => {
  it("uses the env var", () => {
    expect(resolveAgentKey({ AGENT_PRIVATE_KEY: ` ${KEY} ` })).toBe(KEY);
  });

  it("reads the file and trims whitespace and the trailing newline", () => {
    const read = (p: string) => (p === "/run/secrets/k" ? `\n  ${KEY}\n` : "");
    expect(resolveAgentKey({ AGENT_PRIVATE_KEY_FILE: "/run/secrets/k" }, read)).toBe(KEY);
  });

  it("errors when both are given", () => {
    expect(() => resolveAgentKey({ AGENT_PRIVATE_KEY: KEY, AGENT_PRIVATE_KEY_FILE: "/x" }, () => KEY)).toThrow(
      /only one of/,
    );
  });

  it("errors when neither is given", () => {
    expect(() => resolveAgentKey({})).toThrow(/AGENT_PRIVATE_KEY or AGENT_PRIVATE_KEY_FILE/);
  });

  it("errors on an empty or unreadable file without echoing content", () => {
    expect(() => resolveAgentKey({ AGENT_PRIVATE_KEY_FILE: "/x" }, () => " \n")).toThrow(/empty/);
    const boom = () => {
      throw Object.assign(new Error(`ENOENT leaking ${KEY}`), { code: "ENOENT" });
    };
    try {
      resolveAgentKey({ AGENT_PRIVATE_KEY_FILE: "/x" }, boom);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("ENOENT");
      expect((e as Error).message).not.toContain("TOPSECRET");
    }
  });
});

describe("loadConfig with a key file", () => {
  it("loads the key from the file", () => {
    const cfg = loadConfig({ ...base, AGENT_PRIVATE_KEY_FILE: "/k" }, () => `${KEY}\n`);
    expect(cfg.agentPrivateKey).toBe(KEY);
  });

  it("never echoes a malformed key", () => {
    try {
      loadConfig({ ...base, AGENT_PRIVATE_KEY_FILE: "/k" }, () => "secp256k1:TOPSECRETVALUE");
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("TOPSECRET");
    }
  });
});
