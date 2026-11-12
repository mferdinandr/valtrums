import type { LifecycleBattleView } from "../read-source.js";
import {
  ENTITLEMENT_DEPOSIT,
  ESCROW_DEPOSIT_YOCTO,
  JOIN_DEPOSIT_YOCTO,
  MAX_EXECUTE_BATCH,
  MAX_SETTLE_BATCH,
  ONE_YOCTO,
  PAYOUT_REQUEST_DEPOSIT_YOCTO,
  VOTE_DEPOSIT_YOCTO,
  type ActionRequest,
  type FunctionCall,
  type Preview,
  type PreviewContext,
  fail,
  gas,
  hexBytes,
} from "./preview.js";
import type { ActionReadSource } from "./source.js";

/** NEP-145 registration attach (0.01 NEAR); a registration-only deposit is refunded above the token's minimum. */
const REGISTER_REPRESENTATION_DEPOSIT_YOCTO = "10000000000000000000000";
import { isFunded } from "../read-source.js";

/**
 * Previews of the open-arena actions (join, cancel, refund) and of the end-of-battle actions
 * (settlement, the DAO vote, escrow, execution and burn handoff). Each prepares exactly one
 * transaction signed by the account named in the preview; nothing here signs or sends. Anything the
 * contract itself re-checks (a second vote, the exact storage cost, the start window at execution
 * time) is listed as a limitation instead of being guessed.
 */

type Base = Pick<Preview, "version" | "network" | "createdAtMs" | "expiresAtMs" | "source">;

const EVM = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^[0-9a-f]{64}$/;

async function battleOf(source: ActionReadSource, battleId: number): Promise<LifecycleBattleView> {
  const battle = await source.battle(battleId);
  return battle ?? fail("battle_not_found", `battle ${battleId} not found`);
}

const startMs = (battle: LifecycleBattleView): bigint | null => (battle.start_at_ms ? BigInt(battle.start_at_ms) : null);

function user(
  base: Base,
  kind: Preview["kind"],
  caller: string,
  receiverId: string,
  call: Omit<FunctionCall, "type" | "gas"> & { gasTgas: bigint },
  binding: Record<string, unknown>,
  notes: string[],
  limitations: string[],
): Preview {
  const { gasTgas, ...rest } = call;
  return {
    ...base,
    kind,
    accountId: caller,
    signerId: caller,
    authorization: "user_signature",
    binding,
    costs: { attachedDepositYocto: call.deposit, gasTgas: gasTgas.toString(), notes },
    transaction: { signerId: caller, receiverId, actions: [{ type: "FunctionCall", ...rest, gas: gas(gasTgas) }] },
    limitations,
  };
}

/** Returns the preview for a lifecycle action kind, or null when `request` is another kind. */
export async function buildLifecyclePreview(
  request: ActionRequest,
  caller: string,
  source: ActionReadSource,
  ctx: PreviewContext,
  nowMs: number,
  base: Base,
  limitations: string[],
): Promise<Preview | null> {
  const nowNs = BigInt(nowMs) * 1_000_000n;

  if (request.kind === "join_battle") {
    const battle = await battleOf(source, request.battleId);
    if (battle.cancelled) fail("battle_cancelled", "the battle was cancelled; joining is closed");
    if (battle.locked) fail("battle_locked", "the battle is locked; joining is closed");
    const start = startMs(battle);
    if (start !== null && start <= BigInt(nowMs)) fail("battle_started", "the start time has passed; joining is closed");
    const asset = await source.joinableAsset(request.representation);
    if (!asset) return fail("not_joinable", `${request.representation} is not on the joinable-asset allowlist`);
    const index = battle.communities.findIndex((c) => c.representation === request.representation);
    if (index >= 0) {
      const position = await source.position(request.battleId, index, caller);
      if (position.registered) fail("already_registered", "this account already joined this community");
    } else if (battle.communities.length >= 16) {
      fail("battle_full", "the battle already has 16 communities");
    }
    return user(
      base, "join_battle", caller, ctx.arena,
      { methodName: "join_lifecycle_battle", args: { battle_id: request.battleId, representation: request.representation }, deposit: JOIN_DEPOSIT_YOCTO, gasTgas: 30n },
      {
        arena: ctx.arena,
        battleId: request.battleId,
        // The identity comes from the arena's allowlist, never from the joiner; a changed entry rejects the preview.
        asset: { chainId: asset.chain_id, tokenAddress: asset.token_address, representation: asset.representation, custodyDomain: asset.custody_domain, referenceChainId: asset.reference_chain_id, referenceAddress: asset.reference_address },
        startAtMs: battle.start_at_ms ?? null,
      },
      ["deposit is a storage budget (upper bound): the arena charges measured storage and refunds the rest", "joining is not a stake and moves no tokens; deposit with ft_transfer_call after the community passes audit and backing"],
      [
        ...limitations,
        index >= 0 ? `joins the existing community ${index}` : `adds a new community (index ${battle.communities.length}) to the battle; a community counts as entered only after a deposit`,
        "joining is refused by the arena from the start time on and after a cancel",
      ],
    );
  }

  if (request.kind === "cancel_battle") {
    const battle = await battleOf(source, request.battleId);
    if (battle.cancelled) fail("battle_cancelled", "the battle is already cancelled");
    if (battle.locked) fail("battle_locked", "the battle is locked and cannot be cancelled");
    const start = startMs(battle);
    if (start === null) return fail("not_cancellable", "the battle was created without a start time and can never be cancelled");
    if (start > BigInt(nowMs)) fail("battle_not_started", "the start time has not been reached");
    const funded = battle.communities.filter(isFunded).length;
    if (funded >= 2) fail("not_cancellable", `${funded} communities are funded; the battle can lock instead of being cancelled`);
    return user(
      base, "cancel_battle", caller, ctx.arena,
      { methodName: "cancel_lifecycle_battle", args: { battle_id: request.battleId }, deposit: "0", gasTgas: 30n },
      { arena: ctx.arena, battleId: request.battleId, startAtMs: battle.start_at_ms },
      ["no deposit is attached; anyone may cancel once the conditions hold"],
      [...limitations, `${funded} funded communit${funded === 1 ? "y" : "ies"} at the start time: deposits are refundable one by one with claim_refund after the cancel`],
    );
  }

  if (request.kind === "claim_refund") {
    const battle = await battleOf(source, request.battleId);
    if (!battle.cancelled) fail("not_cancelled", "refunds exist only for a cancelled battle");
    const community = battle.communities[request.community];
    if (!community) return fail("invalid_request", `battle ${request.battleId} has no community ${request.community}`);
    const position = await source.position(request.battleId, request.community, caller);
    if (!/^[0-9]+$/.test(position.amount) || BigInt(position.amount) === 0n) fail("nothing_to_refund", "this account has no deposit to refund in this community");
    return user(
      base, "claim_refund", caller, ctx.arena,
      { methodName: "claim_lifecycle_refund", args: { battle_id: request.battleId, community: request.community }, deposit: ONE_YOCTO, gasTgas: 60n },
      { arena: ctx.arena, battleId: request.battleId, community: request.community, representation: community.representation, amount: position.amount },
      ["one yocto is required by the refund's ft_transfer"],
      [...limitations, "the refund is paid by the arena in a later receipt; if the token transfer fails the arena restores the position and the claim can be repeated", "a transaction hash is not a refund: the lifecycle_refund event after the callback is"],
    );
  }

  if (request.kind === "claim_escrow_refund") {
    const battle = await battleOf(source, request.battleId);
    if (!battle.cancelled) fail("not_cancelled", "an escrow is refunded only for a cancelled battle");
    const escrow = await source.creatorEscrow(request.battleId);
    if (!escrow) return fail("nothing_to_refund", "this battle holds no creator escrow");
    if (escrow.creator !== caller) fail("not_creator", "only the creator can take the escrow back");
    return user(
      base, "claim_escrow_refund", caller, ctx.arena,
      { methodName: "claim_lifecycle_escrow_refund", args: { battle_id: request.battleId }, deposit: ONE_YOCTO, gasTgas: 60n },
      { arena: ctx.arena, battleId: request.battleId, representation: escrow.representation, amount: escrow.amount },
      ["one yocto is required by the refund's ft_transfer"],
      [...limitations, "the escrow is removed before the transfer; if the token transfer fails the arena restores it and the claim can be repeated"],
    );
  }

  if (request.kind === "settle_battle") {
    await battleOf(source, request.battleId);
    const progress = await source.settlementProgress(request.battleId);
    if (!progress) return fail("winner_not_resolved", "no final winner is recorded yet; nothing can be settled");
    if (progress.recorded >= progress.total) fail("already_settled", `all ${progress.total} entitlements are already recorded`);
    const batch = Math.min(MAX_SETTLE_BATCH, progress.total - progress.recorded);
    const deposit = (ENTITLEMENT_DEPOSIT * BigInt(batch)).toString();
    return user(
      base, "settle_battle", caller, ctx.arena,
      { methodName: "settle_lifecycle_battle", args: { battle_id: String(request.battleId), max_entitlements: batch }, deposit, gasTgas: 300n },
      { arena: ctx.arena, battleId: request.battleId, recorded: progress.recorded, total: progress.total, batch },
      [`one batch of ${batch} of ${progress.total - progress.recorded} remaining entitlements; the arena refunds unused deposit`, "repeat the action until recorded equals total"],
      [...limitations, "anyone may settle; the plan is recomputed by the arena from the frozen snapshot and cannot be influenced by the caller", "a failed batch advances nothing and can simply be repeated"],
    );
  }

  if (request.kind === "reserve_escrow") {
    await battleOf(source, request.battleId);
    const d = await source.disposition(request.battleId);
    if (!d || d.status === "no_winner") return fail("winner_not_resolved", "no final winner is recorded yet");
    if (d.escrow_reserved) fail("already_done", "the winning principal is already reserved in the backing's escrow");
    return user(
      base, "reserve_escrow", caller, ctx.arena,
      { methodName: "reserve_lifecycle_escrow", args: { battle_id: String(request.battleId) }, deposit: ESCROW_DEPOSIT_YOCTO, gasTgas: 80n },
      { arena: ctx.arena, battleId: request.battleId, escrowId: d.escrow_id },
      ["escrow storage deposit; the arena refunds the excess"],
      [...limitations, "the escrow must be reserved before a decided disposition can be executed"],
    );
  }

  if (request.kind === "vote_disposition") {
    const battle = await battleOf(source, request.battleId);
    const d = await source.disposition(request.battleId);
    if (!d || d.status === "no_winner" || battle.principal_community === null) return fail("winner_not_resolved", "no final winner is recorded yet");
    if (d.status === "no_vote") fail("vote_not_open", "this battle was created without a vote window");
    if (d.status !== "voting") fail("vote_closed", "the vote window has closed");
    if (d.opens_at_ns && BigInt(d.opens_at_ns) > nowNs) fail("vote_not_open", "the vote window has not opened");
    if (d.closes_at_ns && BigInt(d.closes_at_ns) <= nowNs) fail("vote_closed", "the vote window has closed");
    const position = await source.position(request.battleId, battle.principal_community, caller);
    if (!/^[0-9]+$/.test(position.amount) || BigInt(position.amount) === 0n) fail("not_a_winner", "only participants of the winning community can vote");
    return user(
      base, "vote_disposition", caller, ctx.arena,
      { methodName: "vote_lifecycle_disposition", args: { battle_id: String(request.battleId), burn_percent: request.burnPercent }, deposit: VOTE_DEPOSIT_YOCTO, gasTgas: 30n },
      { arena: ctx.arena, battleId: request.battleId, burnPercent: request.burnPercent, community: battle.principal_community, weight: position.amount, closesAtNs: d.closes_at_ns },
      ["vote storage deposit (upper bound); the arena refunds the rest"],
      [...limitations, "one vote per account and it is final; the arena refuses a second vote (no view shows who voted)", "no quorum: the weighted average burn share of the votes cast applies to every holder"],
    );
  }

  if (request.kind === "execute_disposition") {
    await battleOf(source, request.battleId);
    const d = await source.disposition(request.battleId);
    if (!d || d.status === "no_winner") return fail("winner_not_resolved", "no final winner is recorded yet");
    if (d.status === "no_vote") return fail("nothing_to_execute", "this battle has no vote; the principal stays escrowed");
    if (d.status === "voting") return fail("vote_not_open", "the vote is still open; execution starts after the window closes");
    if (d.status === "undecided_escrowed") return fail("nothing_to_execute", "no vote was cast; the principal stays escrowed");
    if (!d.escrow_reserved) fail("escrow_not_reserved", "reserve the escrow before executing the disposition");
    const released = d.released;
    const total = d.total_releases;
    if (typeof released !== "number" || typeof total !== "number") return fail("invalid_request", "the disposition view has no release counts");
    if (released >= total) fail("already_done", `all ${total} releases are already recorded`);
    const batch = Math.min(MAX_EXECUTE_BATCH, total - released);
    return user(
      base, "execute_disposition", caller, ctx.arena,
      { methodName: "execute_lifecycle_disposition", args: { battle_id: String(request.battleId), max_releases: batch }, deposit: (ENTITLEMENT_DEPOSIT * BigInt(batch)).toString(), gasTgas: 250n },
      { arena: ctx.arena, battleId: request.battleId, released, total, batch },
      [`one batch of ${batch} of ${total - released} remaining releases; the arena refunds unused deposit`, "repeat the action until released equals total"],
      [...limitations, "a recorded burn is a reservation for the sink, not a confirmed source burn; request_dao_burn starts its transfer"],
    );
  }

  if (request.kind === "register_representation") {
    if (await source.storageRegistered(request.backing, caller)) fail("already_done", "you are already registered on this token");
    return user(
      base, "register_representation", caller, request.backing,
      { methodName: "storage_deposit", args: { account_id: caller, registration_only: true }, deposit: REGISTER_REPRESENTATION_DEPOSIT_YOCTO, gasTgas: 30n },
      { backing: request.backing, account: caller },
      ["NEP-145 storage deposit; with registration_only the token refunds the part above its minimum"],
      [...limitations, "registration only lets this account hold the token; it moves no tokens"],
    );
  }

  if (request.kind === "claim_entitlement") {
    const available = await source.entitlement(request.backing, caller);
    if (available < BigInt(request.amount)) fail("insufficient_entitlement", "the available entitlement is lower than the amount");
    if (!(await source.storageRegistered(request.backing, caller))) fail("not_registered", "register on this token first (register_representation)");
    return user(
      base, "claim_entitlement", caller, request.backing,
      { methodName: "claim_entitlement_as_representation", args: { amount: request.amount }, deposit: "1", gasTgas: 30n },
      { backing: request.backing, beneficiary: caller, amount: request.amount, available: available.toString() },
      ["one yoctoNEAR"],
      [...limitations, "the tokens are minted into your NEAR account 1:1 from your entitlement; the custody on the source chain does not move", "redeeming them to the source chain is a separate payout request"],
    );
  }

  if (request.kind === "request_dao_burn" || request.kind === "late_refund") {
    if (!ctx.payout) return fail("not_configured", "no payout contract is configured");
    if (request.kind === "late_refund") {
      const requestId = request.requestId as string;
      return user(
        base, "late_refund", caller, ctx.payout,
        {
          methodName: "request_late_refund",
          args: { backing: request.backing, beneficiary: caller, request_id: hexBytes(requestId), amount: request.amount, refund_address: hexBytes(request.destination.slice(2)) },
          deposit: PAYOUT_REQUEST_DEPOSIT_YOCTO,
          gasTgas: 150n,
        },
        { payout: ctx.payout, backing: request.backing, beneficiary: caller, amount: request.amount, destination: request.destination, requestId },
        ["request storage deposit; unused part refunded"],
        [...limitations, "the backing accepts a refund only to the EVM address bound at deposit to this account's own late deposits and rejects any other value", "the refund then follows the signing and confirmation path of a payout"],
      );
    }
    const battle = await battleOf(source, request.battleId);
    if (battle.principal_community === null) return fail("winner_not_resolved", "no final winner is recorded yet");
    const releases = await source.releases(request.battleId);
    const burn = releases.find((r) => r.kind === "burn");
    if (!burn) return fail("nothing_to_execute", "the decided disposition has no burn release");
    if (!burn.recorded) fail("release_not_recorded", "execute the disposition first: the burn release is not recorded in the backing yet");
    if (!HEX32.test(burn.id)) fail("invalid_request", "the burn release id is not 32 bytes of lowercase hex");
    const backing = battle.communities[battle.principal_community]?.representation ?? fail("invalid_request", "the winning community is missing");
    const sink = await source.daoSink(backing);
    if (!sink) return fail("sink_not_set", "the backing has no frozen DAO burn sink yet");
    if (!EVM.test(sink)) fail("invalid_request", "the backing's DAO sink is not a 20-byte hex address");
    const destination = sink.toLowerCase();
    return user(
      base, "request_dao_burn", caller, ctx.payout,
      {
        methodName: "request_dao_burn",
        args: { backing, holder: ctx.arena, request_id: hexBytes(burn.id), destination: hexBytes(destination.slice(2)) },
        deposit: PAYOUT_REQUEST_DEPOSIT_YOCTO,
        gasTgas: 150n,
      },
      { payout: ctx.payout, backing, holder: ctx.arena, battleId: request.battleId, requestId: burn.id, destination, amount: burn.amount },
      ["request storage deposit; unused part refunded"],
      [...limitations, "the amount and destination come from the arena's recorded burn release and the backing's frozen sink, never from the caller", "a burn counts as done only after a finalized debit to the sink is confirmed on the source chain"],
    );
  }

  return null;
}
