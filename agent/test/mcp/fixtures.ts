import { generateKey, generateNonce, verifyNep413Signature } from "near-kit";
import { FixtureArenaReadSource, type LifecycleBattleView, type PayoutView } from "../../src/mcp/read-source.js";
import { READ_SESSION_MESSAGE, ReadSessions } from "../../src/mcp/session.js";
import type { ReadToolDeps } from "../../src/mcp/tools.js";

/** Fixture-only test data: nothing here was observed on a live network. */
export const RECIPIENT = "valtrum-read.test";
export const NOW = 1_800_000_000_000;

const community = (rep: string, token: string) => ({
  chain_id: "46630", token_address: token, representation: rep, custody_domain: "custody-v1",
  reference_chain_id: null, reference_address: null, vault: "0", audit_policy_hash: null,
  audit_evidence_hash: null, audit_expires_at_ms: null, backing_evidence_hash: null,
});

export const battle = (over: Partial<LifecycleBattleView> = {}): LifecycleBattleView => ({
  creator: "creator.testnet", protocol: "protocol.testnet", protocol_created: false, fee_bps: 10, creator_share_bps: 5000,
  mode: "PriceGain", locked: false, observation_policy_version: null, observation_policy_hash: null,
  principal_community: null, principal_amount: null,
  communities: [community("pepe.rep.testnet", "0x" + "a".repeat(40)), community("doge.rep.testnet", "0x" + "b".repeat(40))],
  ...over,
});

const payout = (holder: string, amount: string): PayoutView => ({
  backing: "backing.testnet", holder, request_id: "r", state: "Broadcast", terminal: false, chain_id: "46630", amount, attempts: [], evidence_hash: null,
});

export function makeSource() {
  return new FixtureArenaReadSource("near-testnet", {
    battles: new Map([
      [1, battle()],
      [2, battle({ mode: "LowestDrawdown", locked: true, principal_community: 0, principal_amount: "500" })],
      [3, battle({ creator: "whale.testnet", locked: true })],
    ]),
    rounds: new Map([
      [2, { round_id: "1", candidates: [0, 1], start_ns: "1", end_ns: "2", winner: 0 }],
      [3, { round_id: "2", candidates: [0, 1], start_ns: "1", end_ns: "2", winner: null }],
    ]),
    positions: new Map([
      [FixtureArenaReadSource.positionKey(1, 0, "alice.testnet"), { registered: true, amount: "100" }],
      [FixtureArenaReadSource.positionKey(2, 0, "alice.testnet"), { registered: true, amount: "250" }],
      [FixtureArenaReadSource.positionKey(1, 1, "bob.testnet"), { registered: true, amount: "999" }],
    ]),
    payouts: [payout("alice.testnet", "7"), payout("bob.testnet", "8")],
  });
}

export function makeSessions(now = () => NOW) {
  return new ReadSessions({
    secret: new Uint8Array(32).fill(7),
    recipient: RECIPIENT,
    now,
    // Production passes `near` so near-kit checks the key is a full-access key of the account;
    // here a fixture key registry stands in for that chain lookup.
    verify: async (signed, params) =>
      FULL_ACCESS_KEYS.get(signed.accountId)?.has(signed.publicKey) === true &&
      verifyNep413Signature(signed, params, { nonceValidation: "none" }),
  });
}

/** Fixture stand-in for on-chain full-access keys (account -> public keys). */
export const FULL_ACCESS_KEYS = new Map<string, Set<string>>();

export function nonceAt(ms: number): Uint8Array {
  const n = generateNonce();
  new DataView(n.buffer, n.byteOffset, 8).setBigUint64(0, BigInt(ms), false);
  return n;
}

export function signRead(accountId: string, opts: { at?: number; message?: string; recipient?: string } = {}) {
  const key = generateKey();
  const keys = FULL_ACCESS_KEYS.get(accountId) ?? new Set<string>();
  keys.add(key.publicKey.toString());
  FULL_ACCESS_KEYS.set(accountId, keys);
  const nonce = nonceAt(opts.at ?? NOW);
  if (!key.signNep413Message) throw new Error("near-kit key cannot sign NEP-413");
  const signed = key.signNep413Message(accountId, {
    message: opts.message ?? READ_SESSION_MESSAGE,
    recipient: opts.recipient ?? RECIPIENT,
    nonce,
  });
  return { accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: Buffer.from(nonce).toString("base64") };
}

export async function makeDeps(): Promise<ReadToolDeps & { aliceToken: string; bobToken: string }> {
  const sessions = makeSessions();
  const aliceToken = (await sessions.open(signRead("alice.testnet"))).token;
  const bobToken = (await sessions.open(signRead("bob.testnet"))).token;
  return { arena: makeSource(), sessions, now: () => NOW, aliceToken, bobToken };
}
