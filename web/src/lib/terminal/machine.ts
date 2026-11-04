// Terminal state machine: prompt -> parse -> validate -> confirm -> (quote -> confirm funding) -> execute.
// Framework-free so it can be tested end to end against the mock API; the React hook only subscribes to it.

import type { ArenaApi } from "../arena/types";
import type { TerminalChain, TxSender } from "./chain";
import { executeDeposit, freezePlan, type ExecutionResult } from "./executor";
import type { FundingQuote, FundingRouter } from "./funding";
import { MAX_PROMPT_CHARS, type IntentParser } from "./intent";
import { resolveIntent, type DepositPlan } from "./plan";
import { hasActionWord } from "./rule-parser";
import { buildSummary, type Summary } from "./summary";

export type TerminalState =
  | { phase: "idle" }
  | { phase: "parsing" }
  | { phase: "clarify"; question: string; prompt: string }
  | { phase: "blocked"; reasons: string[] }
  | { phase: "error"; message: string }
  | { phase: "confirm"; plan: DepositPlan; summary: Summary }
  | { phase: "quoting"; plan: DepositPlan }
  | { phase: "funding_confirm"; plan: DepositPlan; summary: Summary; quotes: FundingQuote[] }
  | { phase: "executing"; plan: DepositPlan; stage: "funding" | "depositing"; depositAddress?: { chain: string; address: string; amount: bigint } }
  | { phase: "done"; plan: DepositPlan; result: Extract<ExecutionResult, { ok: true }> }
  | { phase: "failed"; plan: DepositPlan; result: Extract<ExecutionResult, { ok: false }> };

export interface HistoryEntry {
  id: number;
  kind: "input" | "info" | "error" | "success";
  text: string;
}

export interface TerminalDeps {
  parser: IntentParser;
  api: ArenaApi;
  chain: TerminalChain;
  sender: TxSender;
  funding: FundingRouter;
  getAccountId: () => string | null;
  now?: () => number;
  /** When set (battle page), prompts that do not name a battle are scoped to it. */
  scopeBattleId?: number;
}

export interface TerminalController {
  getState(): TerminalState;
  getHistory(): readonly HistoryEntry[];
  subscribe(fn: () => void): () => void;
  submit(prompt: string): Promise<void>;
  /** Confirm the summary. `refundTo` maps chain -> refund address and is required when bridging. */
  confirm(refundTo?: Record<string, string>): Promise<void>;
  confirmFunding(): Promise<void>;
  cancel(): void;
}

export function createTerminal(deps: TerminalDeps): TerminalController {
  const now = deps.now ?? Date.now;
  let state: TerminalState = { phase: "idle" };
  let history: HistoryEntry[] = [];
  let seq = 0;
  let busy = false;
  let refunds: Record<string, string> = {};
  const listeners = new Set<() => void>();

  const emit = () => listeners.forEach((l) => l());
  const set = (s: TerminalState) => {
    state = s;
    emit();
  };
  const log = (kind: HistoryEntry["kind"], text: string) => {
    history = [...history, { id: ++seq, kind, text }];
  };

  async function runExecution(plan: DepositPlan, quotes: FundingQuote[]) {
    set({ phase: "executing", plan, stage: plan.bridgeLegs.length > 0 ? "funding" : "depositing" });
    const result = await executeDeposit(plan, plan, { ...deps, api: deps.api }, {
      fundingQuotes: quotes,
      onStage: (stage) => set({ phase: "executing", plan, stage }),
      fundingHooks: {
        onDepositAddress: (info) => set({ phase: "executing", plan, stage: "funding", depositAddress: info }),
      },
    });
    if (result.ok) {
      log("success", `Deposit sent for battle ${plan.battleLabel} (approved via ${result.via}).`);
      set({ phase: "done", plan, result });
    } else {
      log("error", result.reason);
      set({ phase: "failed", plan, result });
    }
  }

  const controller: TerminalController = {
    getState: () => state,
    getHistory: () => history,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async submit(raw) {
      if (busy) return;
      let prompt = raw.trim();
      if (prompt === "") return;
      const accountId = deps.getAccountId();
      log("input", prompt);
      if (!accountId) {
        log("error", "Connect a wallet first.");
        return set({ phase: "error", message: "Connect a wallet first." });
      }
      // A short reply to a clarifying question extends the previous prompt instead of replacing it.
      if (state.phase === "clarify" && !hasActionWord(prompt)) prompt = `${state.prompt} ${prompt}`.slice(0, MAX_PROMPT_CHARS);
      busy = true;
      set({ phase: "parsing" });
      try {
        const parsed = await deps.parser.parse(prompt);
        if (!parsed.ok) {
          if (parsed.clarify) {
            log("info", parsed.error);
            return set({ phase: "clarify", question: parsed.error, prompt });
          }
          log("error", parsed.error);
          return set({ phase: "error", message: parsed.error });
        }
        const intent = deps.scopeBattleId !== undefined && parsed.intent.battle === undefined ? { ...parsed.intent, battle: deps.scopeBattleId } : parsed.intent;
        const res = await resolveIntent(intent, { api: deps.api, chain: deps.chain, accountId, nowMs: now() });
        if (res.kind === "clarify") {
          log("info", res.question);
          return set({ phase: "clarify", question: res.question, prompt });
        }
        if (res.kind === "blocked") {
          res.reasons.forEach((r) => log("error", r));
          return set({ phase: "blocked", reasons: res.reasons });
        }
        const plan = freezePlan(res.plan);
        log("info", "Review the summary and confirm to continue.");
        set({ phase: "confirm", plan, summary: buildSummary(plan) });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Something went wrong";
        log("error", message);
        set({ phase: "error", message });
      } finally {
        busy = false;
      }
    },

    async confirm(refundTo = {}) {
      if (busy || state.phase !== "confirm") return;
      const { plan, summary } = state;
      busy = true;
      try {
        if (plan.bridgeLegs.length === 0) return await runExecution(plan, []);
        refunds = { ...refunds, ...refundTo };
        const missing = plan.bridgeLegs.find((l) => !refunds[l.chain]?.trim());
        if (missing) {
          const message = `Enter a refund address on ${missing.chain} first.`;
          log("error", message);
          return set({ phase: "error", message });
        }
        set({ phase: "quoting", plan });
        const quotes: FundingQuote[] = [];
        for (const leg of plan.bridgeLegs) {
          quotes.push(await deps.funding.quote({ chain: leg.chain, amount: leg.amount, recipient: plan.accountId, refundTo: refunds[leg.chain]!.trim() }));
        }
        log("info", "Review the cross-chain quote and confirm to start funding.");
        set({ phase: "funding_confirm", plan, summary, quotes });
      } catch (e) {
        const message = e instanceof Error ? e.message : "Could not get a quote";
        log("error", `${message}. Nothing was deposited.`);
        set({ phase: "error", message });
      } finally {
        busy = false;
      }
    },

    async confirmFunding() {
      if (busy || state.phase !== "funding_confirm") return;
      const { plan, quotes } = state;
      busy = true;
      try {
        await runExecution(plan, quotes);
      } finally {
        busy = false;
      }
    },

    cancel() {
      if (busy) return;
      if (state.phase !== "idle") log("info", "Cancelled. Nothing was sent.");
      set({ phase: "idle" });
    },
  };
  return controller;
}
