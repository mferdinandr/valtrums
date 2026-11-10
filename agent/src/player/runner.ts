import { ActionError, type UnsignedTransaction } from "../mcp/actions/preview.js";
import type { ActionService } from "../mcp/actions/service.js";
import type { ActionReadSource } from "../mcp/actions/source.js";
import type { PlayerAgentConfig } from "./config.js";
import type { ModelProposer } from "./model.js";
import { PlayerState, stateKey } from "./state.js";
import { decide, maxAmount, type Option } from "./strategy.js";


const HOUR_MS = 3_600_000;
/** A community the service refused (audit missing, position not registered...) is not asked again for this long. */
const BLOCK_MS = 10 * 60_000;
const POLL_ATTEMPTS = 10;
const POLL_MS = 2_000;

export type TickOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "no_option"; reason: string }
  | { kind: "dry_run"; actionId: string; battleId: number; community: number; amount: string; transaction: UnsignedTransaction }
  | { kind: "submitted"; actionId: string; battleId: number; community: number; amount: string; txHash: string; status: string }
  | { kind: "error"; message: string };

export interface RunnerDeps {
  actions: Pick<ActionService, "propose" | "authorize" | "prepare" | "reportBroadcast" | "refresh">;
  source: Pick<ActionReadSource, "battle" | "position" | "grant" | "budget">;
  battleCount: () => Promise<number>;
  /** Signs and sends the prepared transaction with the delegate's own key; returns its hash. */
  sign: (agent: PlayerAgentConfig, tx: UnsignedTransaction) => Promise<string>;
  state: PlayerState;
  model?: ModelProposer;
  now: () => number;
  log: (event: Record<string, unknown>) => void;
  /** False (the default) stops after the transaction is prepared; nothing is signed or sent. */
  live: boolean;
  sleep?: (ms: number) => Promise<void>;
}

const bytes = (hex: string): number[] => Array.from(Buffer.from(hex, "hex"));

/**
 * One decision round for one agent. It reads the chain, chooses a deposit, and sends it through the same
 * preview, grant check and revalidation path as every other action. The delegate then signs only the contract's
 * `reserve`, which re-checks the whole grant atomically. This program never moves tokens: executing a reserved
 * deposit is a separate, open decision.
 */
export async function tick(agent: PlayerAgentConfig, deps: RunnerDeps): Promise<TickOutcome> {
  const { state, now, log } = deps;
  const skip = (reason: string): TickOutcome => {
    log({ event: "skipped", agent: agent.delegate, reason });
    return { kind: "skipped", reason };
  };
  if (state.failures >= agent.maxFailures) return skip("circuit_open");
  if (state.actedSince(now() - HOUR_MS) >= agent.maxPerHour) return skip("hourly_limit");

  const localId = bytes(agent.localId);
  const grant = await deps.source.grant(agent.user, localId);
  if (!grant) return skip("grant_missing");
  if (grant.delegate !== agent.delegate) return skip("grant_delegate_mismatch");
  if (grant.revoked) return skip("grant_revoked");
  if (BigInt(grant.expiry_ns) <= BigInt(now()) * 1_000_000n) return skip("grant_expired");
  const budget = await deps.source.budget(agent.user, localId);
  if (!budget) return skip("budget_missing");
  const available = BigInt(budget.available);
  const cap = BigInt(grant.per_action_cap);
  if (available <= 0n) return skip("budget_exhausted");

  // Only open battles, and only communities where the user already has a registered position: the agent cannot
  // register one (that needs the user's own signature) and a deposit without it would be refused.
  const options: Option[] = [];
  const count = await deps.battleCount();
  for (let id = count, scanned = 0; id >= 1 && scanned < agent.scanBattles; id--, scanned++) {
    const battle = await deps.source.battle(id);
    if (!battle || battle.locked) continue;
    for (const [community, c] of battle.communities.entries()) {
      const key = stateKey(agent.user, agent.localId, id, community);
      if (state.has(key) || state.isBlocked(key, now())) continue;
      const position = await deps.source.position(id, community, agent.user);
      if (!position.registered) continue;
      options.push({ battleId: id, community, vault: BigInt(c.vault) });
    }
  }
  if (options.length === 0) {
    log({ event: "no_option", agent: agent.delegate });
    return { kind: "no_option", reason: "no open battle with a registered position" };
  }

  let output: unknown;
  const limit = maxAmount(cap, available, agent.fractionBps);
  if (agent.mode === "model") {
    if (!deps.model) return skip("model_not_configured");
    output = await deps.model.propose({ strategy: agent.strategy, user: agent.user, options, maxAmount: limit });
    if (output === null) {
      const n = state.recordFailure();
      log({ event: "model_failed", agent: agent.delegate, failures: n });
      return { kind: "error", message: "the model gave no answer" };
    }
  } else {
    const d = decide(agent.strategy, options, cap, available, agent.fractionBps);
    if (!d) return skip("nothing_to_back");
    output = { action: "deposit", user: agent.user, battleId: d.battleId, community: d.community, amount: d.amount, rationale: d.rationale };
  }

  let actionId = "";
  try {
    const record = await deps.actions.propose(agent.delegate, output);
    actionId = record.actionId;
    const request = record.request as { battleId: number; community: number; amount: string };
    await deps.actions.authorize(actionId, agent.delegate, { kind: "grant" });
    const { transaction } = await deps.actions.prepare(actionId, agent.delegate);
    if (!deps.live) {
      log({ event: "dry_run", agent: agent.delegate, actionId, battleId: request.battleId, community: request.community, amount: request.amount });
      return { kind: "dry_run", actionId, battleId: request.battleId, community: request.community, amount: request.amount, transaction };
    }
    const txHash = await deps.sign(agent, transaction);
    // Remember the send before anything else can fail: a transaction that left must never be sent again.
    const key = stateKey(agent.user, agent.localId, request.battleId, request.community);
    state.markActed(key, { at: now(), actionId, txHash, status: "sent" });
    let status = "sent";
    try {
      await deps.actions.reportBroadcast(actionId, agent.delegate, txHash);
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      status = "broadcast";
      for (let i = 0; i < POLL_ATTEMPTS; i++) {
        const current = await deps.actions.refresh(actionId, agent.delegate);
        status = current.status;
        if (status === "confirmed" || status === "failed" || status === "rejected" || status === "expired") break;
        await sleep(POLL_MS);
      }
      state.markActed(key, { at: now(), actionId, txHash, status });
    } catch (e) {
      // The transaction is already out. Report it as unverified rather than failing or retrying.
      log({ event: "unverified", agent: agent.delegate, actionId, txHash, message: e instanceof Error ? e.message : String(e) });
      status = "unverified";
    }
    log({ event: "submitted", agent: agent.delegate, actionId, txHash, status });
    return { kind: "submitted", actionId, battleId: request.battleId, community: request.community, amount: request.amount, txHash, status };
  } catch (err) {
    if (err instanceof ActionError) {
      // The service refused this proposal (for example audit missing). Not a program failure: back off from it.
      const o = output as { battleId?: number; community?: number } | string | null;
      if (o && typeof o === "object" && Number.isInteger(o.battleId) && Number.isInteger(o.community)) {
        state.markBlocked(stateKey(agent.user, agent.localId, o.battleId!, o.community!), now() + BLOCK_MS);
      }
      log({ event: "refused", agent: agent.delegate, code: err.code, message: err.message });
      return { kind: "skipped", reason: `refused:${err.code}` };
    }
    const n = state.recordFailure();
    const message = err instanceof Error ? err.message : String(err);
    log({ event: "error", agent: agent.delegate, actionId, failures: n, message });
    return { kind: "error", message };
  }
}
