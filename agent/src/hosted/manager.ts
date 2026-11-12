import type { AutonomousAgentConfig } from "../player/autonomous.js";
import type { ModelInput, ModelProposer } from "../player/model.js";
import { isStrategyName } from "../player/strategy.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import type { AgentStore, HostedAgent } from "./store.js";

/** Operator-set limits. They have no defaults: the operator chooses them in the environment. */
export interface HostedLimits {
  maxAgentsPerOwner: number;
  maxModelCallsPerAgentHour: number;
  maxModelCallsGlobalHour: number;
  /** Whole tokens of any one token an agent may hold and still be started. */
  maxTokenWholePerAgent: number;
}

export class HostedError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export interface Funds {
  nearYocto: bigint;
  /** Balance of each joinable token, in base units (18 decimals). */
  tokenBase: bigint[];
}

export interface ManagerDeps {
  store: AgentStore;
  kek: Buffer;
  limits: HostedLimits;
  /** True when the operator has stopped all hosted agents. Read every round. */
  killSwitch: () => boolean;
  now: () => number;
  newKey: () => { account: string; publicKey: string; secretKey: string };
  funds: (account: string) => Promise<Funds>;
  /** Plays one round for one agent with its decrypted key. Throws on an unexpected failure. */
  runRound: (config: AutonomousAgentConfig, secretKey: string) => Promise<void>;
  log: (event: Record<string, unknown>) => void;
}

const HOUR_MS = 3_600_000;
const MAX_ROUND_ERRORS = 3;
const TOKEN_UNIT = 10n ** 18n;

/** Counts NEAR AI calls in a rolling hour across all hosted agents and records them per agent. */
export class ModelBudget {
  private readonly calls: number[] = [];
  constructor(
    private readonly capPerHour: number,
    private readonly now: () => number,
    private readonly onCall: (account: string) => void,
  ) {}
  wrap(model: ModelProposer): ModelProposer {
    const gate = (input: ModelInput): boolean => {
      const since = this.now() - HOUR_MS;
      while (this.calls.length > 0 && this.calls[0]! <= since) this.calls.shift();
      if (this.calls.length >= this.capPerHour) return false;
      this.calls.push(this.now());
      this.onCall(input.user);
      return true;
    };
    return {
      propose: async (input) => (gate(input) ? model.propose(input) : null),
      proposeDetailed: async (input) => {
        if (!gate(input)) return null;
        return model.proposeDetailed ? model.proposeDetailed(input) : (await model.propose(input).then((t) => (t === null ? null : { text: t, chatId: null })));
      },
    };
  }
}

/** The public view of an agent: everything except the key. */
export function publicView(a: HostedAgent) {
  return {
    account: a.account,
    publicKey: a.publicKey,
    style: a.style,
    sweep: a.sweep,
    keepWhole: a.keepWhole,
    running: a.running,
    lastError: a.lastError,
    modelCalls: a.modelCalls,
    createdAt: a.createdAt,
  };
}

export class HostedAgents {
  private readonly failures = new Map<string, number>();
  constructor(private readonly d: ManagerDeps) {}

  list(owner: string) {
    return this.d.store.byOwner(owner).map(publicView);
  }

  private owned(owner: string, account: string): HostedAgent {
    const a = this.d.store.get(account);
    // The same answer for "not yours" and "does not exist", so an owner cannot probe other owners' agents.
    if (!a || a.owner !== owner) throw new HostedError("not_found", "no such agent", 404);
    return a;
  }

  get(owner: string, account: string) {
    return publicView(this.owned(owner, account));
  }

  create(owner: string, input: { style: unknown; sweep: unknown; keepWhole: unknown }) {
    if (this.d.killSwitch()) throw new HostedError("kill_switch", "hosted agents are paused", 503);
    if (!isStrategyName(input.style)) throw new HostedError("bad_style", "style must be crowd or underdog");
    const sweep = input.sweep === true;
    const keepWhole = Number(input.keepWhole ?? 0);
    if (!Number.isInteger(keepWhole) || keepWhole < 0 || keepWhole > 1_000_000_000) throw new HostedError("bad_keep", "keepWhole must be a whole number of tokens");
    if (this.d.store.byOwner(owner).length >= this.d.limits.maxAgentsPerOwner) {
      throw new HostedError("agent_limit", `you can have at most ${this.d.limits.maxAgentsPerOwner} hosted agents`, 403);
    }
    const key = this.d.newKey();
    const agent: HostedAgent = {
      account: key.account,
      publicKey: key.publicKey,
      owner,
      encryptedKey: encryptSecret(this.d.kek, key.account, key.secretKey),
      style: input.style,
      sweep,
      keepWhole,
      running: false,
      createdAt: this.d.now(),
      lastError: null,
      modelCalls: 0,
      exports: [],
    };
    this.d.store.put(agent);
    this.d.log({ event: "hosted_create", account: agent.account, owner });
    return publicView(agent);
  }

  async start(owner: string, account: string) {
    const a = this.owned(owner, account);
    if (this.d.killSwitch()) throw new HostedError("kill_switch", "hosted agents are paused", 503);
    const funds = await this.d.funds(account);
    if (funds.nearYocto === 0n || funds.tokenBase.every((b) => b === 0n)) throw new HostedError("not_funded", "fund the agent with NEAR and a token first", 409);
    const cap = BigInt(this.d.limits.maxTokenWholePerAgent) * TOKEN_UNIT;
    if (funds.tokenBase.some((b) => b > cap)) {
      throw new HostedError("over_fund_cap", `an agent may hold at most ${this.d.limits.maxTokenWholePerAgent} of any token while it runs`, 409);
    }
    this.failures.delete(account);
    this.d.store.put({ ...a, running: true, lastError: null });
    this.d.log({ event: "hosted_start", account });
    return this.get(owner, account);
  }

  stop(owner: string, account: string) {
    const a = this.owned(owner, account);
    this.d.store.put({ ...a, running: false });
    this.d.log({ event: "hosted_stop", account });
    return this.get(owner, account);
  }

  /** Returns the secret key. The owner takes the agent over; the export is recorded. */
  exportKey(owner: string, account: string): { account: string; secretKey: string } {
    const a = this.owned(owner, account);
    this.d.store.put({ ...a, exports: [...a.exports, this.d.now()] });
    this.d.log({ event: "hosted_export", account, owner });
    return { account, secretKey: decryptSecret(this.d.kek, account, a.encryptedKey) };
  }

  recordModelCall(account: string): void {
    const a = this.d.store.get(account);
    if (a) this.d.store.put({ ...a, modelCalls: a.modelCalls + 1 });
  }

  /** Config for the shared autonomous loop. The per-agent model cap comes from the operator, not the owner. */
  config(a: HostedAgent): AutonomousAgentConfig {
    return {
      account: a.account,
      style: a.style,
      keyEnv: "HOSTED_AGENT_KEY",
      fractionBps: 2_500,
      maxPerHour: 6,
      maxModelCallsPerHour: this.d.limits.maxModelCallsPerAgentHour,
      maxFailures: 3,
      intervalSecs: 15,
      scanBattles: 10,
      minStartLeadMs: 90_000,
      approvalWaitMs: 120_000,
      ...(a.sweep ? { sweepTo: a.owner, keepWhole: a.keepWhole } : {}),
    };
  }

  /** One round for every running agent. The kill switch stops them all before anything is signed. */
  async tick(): Promise<void> {
    const running = this.d.store.all().filter((a) => a.running);
    if (this.d.killSwitch()) {
      for (const a of running) this.d.store.put({ ...a, running: false, lastError: "paused by the operator" });
      if (running.length > 0) this.d.log({ event: "hosted_kill_switch", stopped: running.length });
      return;
    }
    for (const a of running) {
      try {
        await this.d.runRound(this.config(a), decryptSecret(this.d.kek, a.account, a.encryptedKey));
        this.failures.delete(a.account);
      } catch (e) {
        const n = (this.failures.get(a.account) ?? 0) + 1;
        this.failures.set(a.account, n);
        const message = e instanceof Error ? e.message : String(e);
        this.d.log({ event: "hosted_error", account: a.account, message });
        if (n >= MAX_ROUND_ERRORS) {
          const latest = this.d.store.get(a.account) ?? a;
          this.d.store.put({ ...latest, running: false, lastError: `stopped after ${n} errors: ${message}` });
        }
      }
    }
  }
}
