import { describe, expect, it } from "vitest";
import {
  HealthState,
  attestationFromEnv,
  handleHealthRequest,
  parseHealthPort,
  startHealthServer,
} from "../src/health.js";

const KEY = "ed25519:SUPERSECRETKEYMATERIAL";
const info = attestationFromEnv(
  { IMAGE_DIGEST: "sha256:abc", AGENT_VERSION: "1.2.3", AGENT_PRIVATE_KEY: KEY },
  { agentAccountId: "agent.testnet", executionMode: "mock", contractId: "arena.testnet" },
);

describe("HealthState readiness", () => {
  it("is not ready before the first successful pass", () => {
    expect(new HealthState(1000, () => 5000).isReady()).toBe(false);
  });

  it("is ready for three intervals after a success, then not", () => {
    let t = 10_000;
    const s = new HealthState(1000, () => t);
    s.markPassSucceeded();
    t += 3000;
    expect(s.isReady()).toBe(true);
    t += 1;
    expect(s.isReady()).toBe(false);
    s.markPassSucceeded();
    expect(s.isReady()).toBe(true);
  });
});

describe("health responses", () => {
  const state = new HealthState(1000, () => 0);

  it("answers liveness regardless of readiness", () => {
    expect(handleHealthRequest("GET", "/healthz", state, info)).toEqual({ status: 200, body: { status: "ok" } });
  });

  it("answers readiness with 503 until a pass succeeded", () => {
    expect(handleHealthRequest("GET", "/readyz", state, info)).toEqual({ status: 503, body: { ready: false } });
    state.markPassSucceeded();
    expect(handleHealthRequest("GET", "/readyz", state, info)).toEqual({ status: 200, body: { ready: true } });
  });

  it("returns the attestation shape", () => {
    expect(handleHealthRequest("GET", "/attestation", state, info).body).toEqual({
      image_digest: "sha256:abc",
      version: "1.2.3",
      agent_account_id: "agent.testnet",
      execution_mode: "mock",
      contract_id: "arena.testnet",
    });
  });

  it("defaults unknown digest and version", () => {
    const i = attestationFromEnv({}, { agentAccountId: "a", executionMode: "mock", contractId: "c" });
    expect(i.imageDigest).toBe("unknown");
    expect(i.version).toBe("unknown");
  });

  it("rejects other methods and paths", () => {
    expect(handleHealthRequest("POST", "/healthz", state, info).status).toBe(405);
    expect(handleHealthRequest("GET", "/nope", state, info).status).toBe(404);
  });

  it("never contains the private key in any response", () => {
    for (const path of ["/healthz", "/readyz", "/attestation", "/other"]) {
      expect(JSON.stringify(handleHealthRequest("GET", path, state, info))).not.toContain("SUPERSECRET");
    }
  });
});

describe("health server", () => {
  it("is disabled on port 0", async () => {
    expect(await startHealthServer(0, new HealthState(1000), info)).toBeUndefined();
  });

  it("serves over http on loopback and never leaks the key", async () => {
    const server = await startHealthServer(18089, new HealthState(1000), info, "127.0.0.1");
    try {
      const ok = await fetch("http://127.0.0.1:18089/healthz");
      expect(ok.status).toBe(200);
      const att = await (await fetch("http://127.0.0.1:18089/attestation")).text();
      expect(att).not.toContain("SUPERSECRET");
      expect(JSON.parse(att).contract_id).toBe("arena.testnet");
    } finally {
      server?.close();
    }
  });
});

describe("parseHealthPort", () => {
  it("defaults to 8080, accepts 0 and rejects garbage", () => {
    expect(parseHealthPort({})).toBe(8080);
    expect(parseHealthPort({ HEALTH_PORT: "0" })).toBe(0);
    expect(parseHealthPort({ HEALTH_PORT: "9000" })).toBe(9000);
    expect(() => parseHealthPort({ HEALTH_PORT: "x" })).toThrow();
    expect(() => parseHealthPort({ HEALTH_PORT: "70000" })).toThrow();
  });
});
