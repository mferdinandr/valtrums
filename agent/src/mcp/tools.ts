import type { ReportArchive } from "../audit/report-archive.js";
import { QueryValidationError, type ReportQuery, queryObservations } from "../audit/report-query.js";
import { type ReadEnvelope, type SourceInfo, envelope } from "./envelope.js";
import type { ArenaReadSource, PayoutView } from "./read-source.js";
import { PAYOUT_DISPLAY_LABELS, payoutDisplayState } from "./payout-display.js";
import { SearchValidationError, parseSearchParams, searchBattles } from "./search.js";
import { type ReadSessions, SessionError } from "./session.js";

/**
 * The read-only MCP / terminal tool set. No tool here signs, sends, reserves budget or creates a
 * grant: handlers only receive read sources and the session verifier. Account-scoped tools resolve
 * the caller from a verified read session and refuse any other account.
 */

export interface ReadToolDeps {
  arena: ArenaReadSource;
  audits?: { archive: ReportArchive; info: SourceInfo };
  sessions: ReadSessions;
  now: () => number;
  /** Age after which a read is reported stale. Live reads are observed at call time. */
  maxAgeMs?: number;
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

type Args = Record<string, unknown>;
type JsonSchema = { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };

export interface ReadTool {
  name: string;
  description: string;
  accountScoped: boolean;
  inputSchema: JsonSchema;
  run(args: Args, deps: ReadToolDeps, caller: string | null): Promise<ReadEnvelope<unknown>>;
}

const MAX_BATTLES_PER_ACCOUNT_READ = 20;
const MAX_PAYOUT_PAGES = 10;
const PAYOUT_PAGE = 50;

const battleIdArg = (args: Args): number => {
  const v = Number(args.battleId);
  if (!Number.isSafeInteger(v) || v < 1) throw new ToolInputError("battleId must be a positive integer");
  return v;
};

const sessionProps = {
  session: { type: "string", description: "Read session token from open_read_session (NEP-413)." },
  accountId: { type: "string", description: "Optional; must equal the session account." },
};

function live(deps: ReadToolDeps, tool: string, info: SourceInfo, data: unknown, limitations: string[] = []): ReadEnvelope<unknown> {
  const nowMs = deps.now();
  return envelope(tool, info, data, { observedAtMs: nowMs, nowMs, maxAgeMs: deps.maxAgeMs ?? 60_000, limitations });
}

async function recentBattleIds(deps: ReadToolDeps, requested: unknown): Promise<number[]> {
  if (requested !== undefined) {
    if (!Array.isArray(requested) || requested.length > MAX_BATTLES_PER_ACCOUNT_READ) {
      throw new ToolInputError(`battleIds must be an array of at most ${MAX_BATTLES_PER_ACCOUNT_READ} ids`);
    }
    return requested.map((id) => battleIdArg({ battleId: id }));
  }
  const count = await deps.arena.battleCount();
  const ids: number[] = [];
  for (let id = count; id >= 1 && ids.length < MAX_BATTLES_PER_ACCOUNT_READ; id--) ids.push(id);
  return ids;
}

export const READ_TOOLS: readonly ReadTool[] = [
  {
    name: "list_battles",
    description: "Search and filter battles server-side (text, scoring mode, status, community) with a bounded page.",
    accountScoped: false,
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        mode: { type: "string" },
        status: { type: "string" },
        community: { type: "string" },
        cursor: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
    async run(args, deps) {
      const page = await searchBattles(deps.arena, parseSearchParams(args));
      return live(deps, "list_battles", deps.arena.info, page, page.truncated ? ["scan limit reached; continue with nextCursor"] : []);
    },
  },
  {
    name: "inspect_battle",
    description: "Read one battle: creator, scoring mode, communities, lock state and current round.",
    accountScoped: false,
    inputSchema: { type: "object", properties: { battleId: { type: "number" } }, required: ["battleId"], additionalProperties: false },
    async run(args, deps) {
      const id = battleIdArg(args);
      const battle = await deps.arena.battle(id);
      if (!battle) throw new ToolInputError(`battle ${id} not found`);
      const round = battle.locked ? await deps.arena.round(id) : null;
      return live(deps, "inspect_battle", deps.arena.info, { battleId: id, battle, round }, [
        "audit and backing evidence hashes are references, not proof of current validity or live backing",
      ]);
    },
  },
  {
    name: "inspect_round",
    description: "Read the current round of a battle: candidates, 30-second window and winner if decided.",
    accountScoped: false,
    inputSchema: { type: "object", properties: { battleId: { type: "number" } }, required: ["battleId"], additionalProperties: false },
    async run(args, deps) {
      const id = battleIdArg(args);
      const round = await deps.arena.round(id);
      return live(deps, "inspect_round", deps.arena.info, { battleId: id, round }, round ? [] : ["no round has started"]);
    },
  },
  {
    name: "inspect_audit",
    description: "Read archived audit report observations for a battle, optionally one community.",
    accountScoped: false,
    inputSchema: {
      type: "object",
      properties: { battleId: { type: "number" }, community: { type: "number" } },
      required: ["battleId"],
      additionalProperties: false,
    },
    async run(args, deps) {
      const id = battleIdArg(args);
      if (!deps.audits) throw new ToolInputError("audit report archive is not configured");
      const query: ReportQuery = { battleId: id, pageSize: 20 };
      if (args.community !== undefined) query.community = args.community as number;
      let page;
      try {
        page = queryObservations(await deps.audits.archive.snapshot(), query, new Date(deps.now()));
      } catch (err) {
        if (err instanceof QueryValidationError) throw new ToolInputError(err.message);
        throw err;
      }
      return live(deps, "inspect_audit", deps.audits.info, { battleId: id, observations: page.items, nextCursor: page.nextCursor }, [
        "an archived report does not establish current approval; read the battle's committed audit evidence",
      ]);
    },
  },
  {
    name: "inspect_positions",
    description: "Read the session account's deposits per battle and community.",
    accountScoped: true,
    inputSchema: {
      type: "object",
      properties: { ...sessionProps, battleIds: { type: "array", items: { type: "number" } } },
      required: ["session"],
      additionalProperties: false,
    },
    async run(args, deps, caller) {
      const account = caller as string;
      const positions = [];
      for (const id of await recentBattleIds(deps, args.battleIds)) {
        const battle = await deps.arena.battle(id);
        if (!battle) continue;
        for (let c = 0; c < battle.communities.length; c++) {
          const p = await deps.arena.position(id, c, account);
          if (p.registered) positions.push({ battleId: id, community: c, representation: battle.communities[c]?.representation, amount: p.amount });
        }
      }
      return live(deps, "inspect_positions", deps.arena.info, { accountId: account, positions }, [
        `only the ${MAX_BATTLES_PER_ACCOUNT_READ} most recent battles are inspected unless battleIds is given`,
      ]);
    },
  },
  {
    name: "inspect_entitlements",
    description: "Read the session account's settlement entitlements.",
    accountScoped: true,
    inputSchema: { type: "object", properties: sessionProps, required: ["session"], additionalProperties: false },
    async run(_args, deps, caller) {
      return live(deps, "inspect_entitlements", deps.arena.info, { accountId: caller, available: false, entitlements: [] }, [
        "no deployed contract exposes per-account entitlements yet; an empty list is not a zero entitlement",
      ]);
    },
  },
  {
    name: "inspect_payouts",
    description: "Read the session account's unresolved payouts and their exact state.",
    accountScoped: true,
    inputSchema: { type: "object", properties: sessionProps, required: ["session"], additionalProperties: false },
    async run(_args, deps, caller) {
      const mine: PayoutView[] = [];
      let from = 0;
      let complete = false;
      for (let page = 0; page < MAX_PAYOUT_PAGES; page++) {
        const res = await deps.arena.openPayouts(from, PAYOUT_PAGE);
        mine.push(...res.items.filter((p) => p.holder === caller));
        // Terminal payouts are skipped, so an empty page is not the end; only a non-advancing index is.
        if (res.nextIndex <= from) {
          complete = true;
          break;
        }
        from = res.nextIndex;
      }
      const limitations = [
        "confirmed and restored payouts are not listed by the payout contract",
        "a broadcast or pending-finality payout is not confirmed until its receipt is verified",
      ];
      if (!complete) limitations.push(`only the first ${MAX_PAYOUT_PAGES * PAYOUT_PAGE} payout index positions were scanned`);
      return live(deps, "inspect_payouts", deps.arena.info, {
        accountId: caller,
        payouts: mine.map((p) => {
          const display = payoutDisplayState(p.state);
          return {
            state: p.state,
            displayState: display,
            displayLabel: PAYOUT_DISPLAY_LABELS[display],
            terminal: p.terminal,
            chainId: p.chain_id,
            amount: p.amount,
            backing: p.backing,
          };
        }),
      }, limitations);
    },
  },
  {
    name: "inspect_escrow",
    description: "Read the session account's winning principal held in DAO escrow.",
    accountScoped: true,
    inputSchema: {
      type: "object",
      properties: { ...sessionProps, battleIds: { type: "array", items: { type: "number" } } },
      required: ["session"],
      additionalProperties: false,
    },
    async run(args, deps, caller) {
      const account = caller as string;
      const held = [];
      for (const id of await recentBattleIds(deps, args.battleIds)) {
        const battle = await deps.arena.battle(id);
        if (!battle || battle.principal_community === null) continue;
        const p = await deps.arena.position(id, battle.principal_community, account);
        if (p.registered && p.amount !== "0") {
          held.push({ battleId: id, community: battle.principal_community, amount: p.amount, disposition: "undecided" });
        }
      }
      return live(deps, "inspect_escrow", deps.arena.info, { accountId: account, escrow: held }, [
        "no disposition vote is implemented yet (D22 governance is decided, execution is #75); principal stays escrowed until a valid vote",
        "escrow is an accounting hold; source-chain disposition is not verified here",
      ]);
    },
  },
];

export const READ_TOOL_NAMES: readonly string[] = READ_TOOLS.map((t) => t.name);

/** Runs one read tool. Unknown names, bad input and foreign accounts are refused before any read. */
export async function callReadTool(name: string, args: Args, deps: ReadToolDeps): Promise<ReadEnvelope<unknown>> {
  const tool = READ_TOOLS.find((t) => t.name === name);
  if (!tool) throw new ToolInputError(`unknown read tool: ${name}`);
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new ToolInputError("arguments must be an object");
  const allowed = new Set(Object.keys(tool.inputSchema.properties));
  for (const k of Object.keys(args)) if (!allowed.has(k)) throw new ToolInputError(`unknown argument: ${k}`);

  let caller: string | null = null;
  if (tool.accountScoped) {
    try {
      caller = deps.sessions.accountOf(args.session);
    } catch (err) {
      throw new AccessDeniedError(err instanceof SessionError ? err.message : "invalid read session");
    }
    if (args.accountId !== undefined && args.accountId !== caller) {
      throw new AccessDeniedError("a read session can only read its own account");
    }
  }
  try {
    return await tool.run(args, deps, caller);
  } catch (err) {
    if (err instanceof SearchValidationError) throw new ToolInputError(err.message);
    throw err;
  }
}
