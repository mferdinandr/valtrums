// FIXTURE-ONLY: synthetic payloads. Labels are display names, never identity or eligibility.
import { describe, expect, it } from "vitest";
import { buildCreateReview, toActionRequest, type AssetDraft } from "./create-review";
import { communityRows, type LifecycleDetail } from "./lifecycle";

const draft = (i: number, label?: string): AssetDraft => ({
  chainId: "46630", tokenAddress: `0x${String(i).repeat(40)}`, representation: `c${i}.rep.testnet`, custodyDomain: "custody-v1",
  referenceChainId: "", referenceAddress: "", ...(label ? { label } : {}),
});

const NOW = 1_800_000_000_000;
const START = String(NOW + 15 * 60_000);

describe("token labels in the create flow", () => {
  it("never puts the display label into the action request or the reviewed arguments", () => {
    const drafts = [draft(1, "mCASHCAT"), draft(2, "mWALLET")];
    const request = JSON.stringify(toActionRequest(drafts, "PriceGain", START));
    expect(request).not.toMatch(/mCASHCAT|mWALLET|label/);
    const review = buildCreateReview("arena.testnet", drafts, "PriceGain", START, NOW);
    expect(review.ok).toBe(true);
    if (review.ok) expect(JSON.stringify(review.args)).not.toMatch(/mCASHCAT|mWALLET|label/);
  });
  it("produces the same request with or without labels", () => {
    expect(toActionRequest([draft(1, "mCASHCAT"), draft(2, "mWALLET")], "PriceGain", START)).toEqual(toActionRequest([draft(1), draft(2)], "PriceGain", START));
  });
});

describe("token labels on community rows", () => {
  const community = (i: number) => ({
    chain_id: "46630", token_address: `0x${String(i).repeat(40)}`, representation: `c${i}.rep.testnet`, custody_domain: "custody-v1",
    reference_chain_id: null, reference_address: null, vault: "1", audit_policy_hash: null, audit_evidence_hash: null, audit_expires_at_ms: null, backing_evidence_hash: null,
  });
  const detail = (labels?: LifecycleDetail["labels"]): LifecycleDetail => ({
    battleId: "1",
    battle: { creator: "a.testnet", protocol: "p.testnet", protocol_created: false, fee_bps: 10, creator_share_bps: 5000, mode: "PriceGain", locked: false,
      observation_policy_version: null, observation_policy_hash: null, principal_community: null, principal_amount: null, communities: [community(1), community(2)] },
    round: null, readiness: null, history: null, ...(labels ? { labels } : {}),
  });
  it("carries the label of each community in order", () => {
    const rows = communityRows(detail([{ symbol: "mCASHCAT", name: "Mock CASHCAT", kind: "testnet-mock" }, null]), 0);
    expect(rows[0]!.label?.symbol).toBe("mCASHCAT");
    expect(rows[1]!.label).toBeNull();
  });
  it("shows no label, and does not fail, when an older service sends none", () => {
    const rows = communityRows(detail(), 0);
    expect(rows.map((r) => r.label)).toEqual([null, null]);
  });
  it("does not let a label change readiness or blockers", () => {
    const labelled = communityRows(detail([{ symbol: "mCASHCAT", name: "Mock CASHCAT", kind: "testnet-mock" }, { symbol: "mWALLET", name: "Mock WALLET", kind: "testnet-mock" }]), 0);
    const plain = communityRows(detail(), 0);
    expect(labelled.map((r) => r.blockers)).toEqual(plain.map((r) => r.blockers));
  });
});
