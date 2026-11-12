import type { ActionReadSource } from "../mcp/actions/source.js";
import type { AutonomousAgentConfig, FunctionCallRequest } from "./autonomous.js";
import { parseVoteChoice, type ModelProposer } from "./model.js";
import type { PlayerState } from "./state.js";

/**
 * What a winning agent does after the battle, with its own key and balance: claim the prize into its own NEAR account,
 * and cast its one vote on the winners' principal. Both read the chain first and never act on a local note alone.
 */
const TGAS = 10n ** 12n;
const gas = (tgas: bigint): string => (tgas * TGAS).toString();
const HOLD_MS = 10 * 60_000;
const MODEL_RETRY_MS = 2 * 60_000;
/** 0.01 NEAR: a registration-only storage deposit (the token refunds the part above its minimum) and a vote's storage (refunded). */
const STORAGE_DEPOSIT_YOCTO = "10000000000000000000000";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface ClaimDeps {
  /** Representations of the arena's joinable tokens (each is its own backing contract). */
  joinable: () => Promise<string[]>;
  /** Available entitlement of `account` on the backing. */
  entitlement: (backing: string, account: string) => Promise<bigint>;
  registered: (token: string, account: string) => Promise<boolean>;
  sign: (agent: AutonomousAgentConfig, call: FunctionCallRequest) => Promise<string>;
  log: (event: Record<string, unknown>) => void;
  live: boolean;
}

/** Claims every positive entitlement into the agent's own account. A failure is logged and never stops the round. */
export async function claimOnce(agent: AutonomousAgentConfig, deps: ClaimDeps): Promise<void> {
  for (const token of await deps.joinable().catch(() => [] as string[])) {
    let available: bigint;
    try {
      available = await deps.entitlement(token, agent.account);
    } catch {
      continue;
    }
    if (available <= 0n) continue;
    if (!deps.live) {
      deps.log({ event: "claim_planned", agent: agent.account, token, amount: available.toString() });
      continue;
    }
    try {
      if (!(await deps.registered(token, agent.account))) {
        await deps.sign(agent, { receiverId: token, methodName: "storage_deposit", args: { account_id: agent.account, registration_only: true }, gas: gas(30n), deposit: STORAGE_DEPOSIT_YOCTO });
      }
      const txHash = await deps.sign(agent, { receiverId: token, methodName: "claim_entitlement_as_representation", args: { amount: available.toString() }, gas: gas(30n), deposit: "1" });
      deps.log({ event: "claimed", agent: agent.account, token, amount: available.toString(), txHash });
    } catch (e) {
      deps.log({ event: "claim_error", agent: agent.account, token, message: message(e) });
    }
  }
}

export interface VoteDeps {
  source: Pick<ActionReadSource, "round" | "position" | "disposition">;
  battleCount: () => Promise<number>;
  arena: string;
  model?: ModelProposer;
  state: PlayerState;
  now: () => number;
  sign: (agent: AutonomousAgentConfig, call: FunctionCallRequest) => Promise<string>;
  log: (event: Record<string, unknown>) => void;
  live: boolean;
}

const voteKey = (account: string, battleId: number): string => `vote:${account}:${battleId}`;

/**
 * Casts the agent's vote in recent battles it won while the vote is open. NEAR AI picks the burn share; the code accepts
 * only a whole number from 0 to 100. One vote per battle: the contract refuses a second, and the agent keeps a note.
 */
export async function voteOnce(agent: AutonomousAgentConfig, deps: VoteDeps): Promise<void> {
  const propose = deps.model?.proposeVote;
  if (!propose || !deps.model) return;
  const count = await deps.battleCount().catch(() => 0);
  for (let id = count, scanned = 0; id >= 1 && scanned < agent.scanBattles; id--, scanned++) {
    const key = voteKey(agent.account, id);
    if (deps.state.has(key) || deps.state.isBlocked(key, deps.now())) continue;
    try {
      const round = await deps.source.round(id);
      if (!round || round.winner === null) continue;
      const disposition = await deps.source.disposition(id);
      if (!disposition || disposition.status !== "voting" || !disposition.closes_at_ns) continue;
      if (BigInt(disposition.closes_at_ns) <= BigInt(deps.now()) * 1_000_000n) continue;
      const position = await deps.source.position(id, round.winner, agent.account);
      if (!/^[0-9]+$/.test(position.amount) || BigInt(position.amount) === 0n) {
        // Not a winning participant of this battle: there is nothing to vote on, now or later.
        deps.state.markActed(key, { at: deps.now(), actionId: key, txHash: null, status: "sent" });
        continue;
      }
      const asked = await propose.call(deps.model, { user: agent.account, battleId: id, burnWeight: disposition.burn_weight, returnWeight: disposition.return_weight });
      const burnPercent = asked ? parseVoteChoice(asked.text) : null;
      if (asked === null || burnPercent === null) {
        deps.state.markBlocked(key, deps.now() + MODEL_RETRY_MS);
        deps.log({ event: "vote_skipped", agent: agent.account, battleId: id, reason: asked === null ? "model_no_answer" : "model_answer_invalid" });
        continue;
      }
      if (!deps.live) {
        deps.log({ event: "vote_planned", agent: agent.account, battleId: id, burnPercent, chatId: asked.chatId });
        continue;
      }
      // Hold the battle back before the vote leaves: if the answer is lost, the next round must not send it again.
      deps.state.markBlocked(key, deps.now() + HOLD_MS);
      const txHash = await deps.sign(agent, { receiverId: deps.arena, methodName: "vote_lifecycle_disposition", args: { battle_id: String(id), burn_percent: burnPercent }, gas: gas(30n), deposit: STORAGE_DEPOSIT_YOCTO });
      deps.state.markActed(key, { at: deps.now(), actionId: key, txHash, status: "sent" });
      deps.log({ event: "voted", agent: agent.account, battleId: id, burnPercent, decidedBy: "near-ai", chatId: asked.chatId, txHash });
    } catch (e) {
      const text = message(e);
      // The contract's own refusals mean there is nothing left to try for this battle.
      if (/Already voted|Vote is closed|Only winning participants/i.test(text)) deps.state.markActed(key, { at: deps.now(), actionId: key, txHash: null, status: "sent" });
      deps.log({ event: "vote_error", agent: agent.account, battleId: id, message: text });
    }
  }
}
