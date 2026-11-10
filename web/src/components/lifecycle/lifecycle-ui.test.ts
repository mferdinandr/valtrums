// Read-only SSR semantics and fallback checks, not browser/visual QA or live-chain evidence.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { LifecycleEnvelope } from "@/lib/arena-read/lifecycle";
import { LifecycleBattleDetail } from "../lifecycle-battle-detail";

const state = vi.hoisted(() => ({
  data: null as LifecycleEnvelope | null,
  loading: false,
  error: null as string | null,
  stale: false,
}));
vi.mock("@/hooks/use-lifecycle-battle", () => ({
  useLifecycleBattle: () => state,
}));
vi.mock("@/hooks/use-now", () => ({ useNow: () => 1_800_000_040_000 }));
vi.mock("@/components/providers", () => ({
  useWallet: () => ({ accountId: null, signIn: vi.fn() }),
  useActionWallet: () => null,
}));
vi.mock("@/components/battle-chart/observation-chart", () => ({
  ObservationChart: () =>
    createElement("p", null, "Persisted observations only"),
}));

const namespace = {
  deploymentId: "fixture-v1",
  network: "near-testnet" as const,
  arenaContract: "arena.testnet",
  protocol: "lifecycle-v2" as const,
};
const render = () =>
  renderToStaticMarkup(
    createElement(LifecycleBattleDetail, { namespace, battleId: "7" }),
  );

beforeEach(() => {
  state.loading = false;
  state.error = null;
  state.stale = false;
  state.data = {
    schemaVersion: "arena-application-v1",
    namespace,
    provenance: {
      kind: "fixture",
      fetchedAtMs: "1800000040000",
      observedAtMs: null,
      readModelVersion: null,
      watermark: null,
      sourceReferences: [],
      finality: "not-applicable",
      health: "healthy",
      complete: false,
      reasons: ["fixture only"],
    },
    data: {
      battleId: "7",
      battle: {
        creator: "creator.testnet",
        protocol: "protocol.testnet",
        protocol_created: false,
        fee_bps: 10,
        creator_share_bps: 5000,
        mode: "PriceGain",
        locked: true,
        observation_policy_version: "1",
        observation_policy_hash: "p",
        principal_community: null,
        principal_amount: null,
        communities: [1, 2, 3].map((i) => ({
          chain_id: "46630",
          token_address: `0x${String(i).repeat(40)}`,
          representation: `crew${i}.testnet`,
          custody_domain: "custody-v1",
          reference_chain_id: null,
          reference_address: null,
          vault: "18446744073709551615",
          audit_policy_hash: "audit",
          audit_evidence_hash: "evidence",
          audit_expires_at_ms: "9999999999999",
          backing_evidence_hash: "backing",
        })),
      },
      round: {
        round_id: "1",
        candidates: [0, 1, 2],
        start_ns: "1800000000000000000",
        end_ns: "1800000030000000000",
        winner: null,
      },
      readiness: null,
      history: null,
    },
  };
});

describe("lifecycle presentation and fallback", () => {
  it("keeps all crews, exact units, pending resolution and chart accessible before WebGL loads", () => {
    const html = render();
    expect(html).toContain("3D arena for battle 7");
    expect(html).toContain("Biggest price climb");
    expect(html).toContain("Awaiting resolution");
    expect(html).toContain("18,446,744,073,709,551,615");
    expect(html).toContain("Crew 03");
    expect(html).toContain("Persisted observations only");
    expect(html).toContain("fixture data");
    expect(html).not.toContain("wins · recorded result");
  });
  it("does not claim a fresh but untrusted/mismatched backing is approved", () => {
    state.data!.data.readiness = {
      schema_version: "v1",
      activated: true,
      paused: false,
      legacy_battle_count: "0",
      activation_blocked_by_legacy: false,
      protocol: "protocol.testnet",
      oracle: null,
      audit_policy_hash: null,
      battle_found: true,
      backings: [0, 1, 2].map((community) => ({
        community,
        representation: `crew${community + 1}.testnet`,
        trusted: false,
        asset_matches: false,
        evidence_hash: "evidence",
        expires_at_ms: "9999999999999",
        fresh: true,
      })),
    };
    const html = render();
    expect(html).toContain("backing not ready");
    expect(html).not.toContain("backing approved");
  });
  it("shows a read error without rendering an invented demo arena", () => {
    state.data = null;
    state.error = "upstream unavailable";
    const html = render();
    expect(html).toContain("could not be read");
    expect(html).not.toContain("3D arena");
  });
});
