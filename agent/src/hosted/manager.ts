import type { AutonomousAgentConfig } from "../player/autonomous.js";
import type { ModelInput, ModelProposer } from "../player/model.js";
import { isStrategyName } from "../player/strategy.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import type { HostedRepository } from "./repository.js";
import type { HostedAgent } from "./store.js";

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
  repo: HostedRepository;
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

  async list(owner: string) {
    return (await this.d.repo.byOwner(owner)).map(publicView);
  }

  private async owned(owner: string, account: string): Promise<HostedAgent> {
    const a = await this.d.repo.get(account);
    // The same answer for "not yours" and "does not exist", so an owner cannot probe other owners' agents.
    if (!a || a.owner !== owner) throw new HostedError("not_found", "no such agent", 404);
    return a;
  }

  async get(owner: string, account: string) {
    return publicView(await this.owned(owner, account));
  }

  async create(owner: string, input: { style: unknown; sweep: unknown; keepWhole: unknown }) {
    if (this.d.killSwitch()) throw new HostedError("kill_switch", "hosted agents are paused", 503);
    if (!isStrategyName(input.style)) throw new HostedError("bad_style", "style must be crowd or underdog");
    const sweep = input.sweep === true;
    const keepWhole = Number(input.keepWhole ?? 0);
    if (!Number.isInteger(keepWhole) || keepWhole < 0 || keepWhole > 1_000_000_000) throw new HostedError("bad_keep", "keepWhole must be a whole number of tokens");
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
    // The repository checks the per-owner limit and inserts in one atomic step.
    if (!(await this.d.repo.create(agent, this.d.limits.maxAgentsPerOwner))) {
      throw new HostedError("agent_limit", `you can have at most ${this.d.limits.maxAgentsPerOwner} hosted agents`, 403);
    }
    this.d.log({ event: "hosted_create", account: agent.account, owner });
    return publicView(agent);
  }

  async start(owner: string, account: string) {
    await this.owned(owner, account);
    if (this.d.killSwitch()) throw new HostedError("kill_switch", "hosted agents are paused", 503);
    const funds = await this.d.funds(account);
    if (funds.nearYocto === 0n || funds.tokenBase.every((b) => b === 0n)) throw new HostedError("not_funded", "fund the agent with NEAR and a token first", 409);
    const cap = BigInt(this.d.limits.maxTokenWholePerAgent) * TOKEN_UNIT;
    if (funds.tokenBase.some((b) => b > cap)) {
      throw new HostedError("over_fund_cap", `an agent may hold at most ${this.d.limits.maxTokenWholePerAgent} of any token while it runs`, 409);
    }
    this.failures.delete(account);
    await this.d.repo.setRunning(account, true, null);
    await this.d.repo.recordEvent(account, "start", {}, this.d.now());
    this.d.log({ event: "hosted_start", account });
    return this.get(owner, account);
  }

  async stop(owner: string, account: string) {
    const a = await this.owned(owner, account);
    await this.d.repo.setRunning(account, false, a.lastError);
    await this.d.repo.recordEvent(account, "stop", {}, this.d.now());
    this.d.log({ event: "hosted_stop", account });
    return this.get(owner, account);
  }

  /** Returns the secret key. The owner takes the agent over; the export is recorded. */
  async exportKey(owner: string, account: string): Promise<{ account: string; secretKey: string }> {
    const a = await this.owned(owner, account);
    const secretKey = decryptSecret(this.d.kek, account, a.encryptedKey);
    await this.d.repo.recordEvent(account, "export", { owner }, this.d.now());
    this.d.log({ event: "hosted_export", account, owner });
    return { account, secretKey };
  }

  /** Counts one NEAR AI call for the agent. A failed write is logged, it never blocks the play. */
  recordModelCall(account: string): void {
    void this.d.repo.incrementModelCalls(account).catch((e) => this.d.log({ event: "hosted_count_error", account, message: e instanceof Error ? e.message : String(e) }));
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
    // If the repository cannot be read, nothing is signed this round (fail closed).
    const running = await this.d.repo.running();
    if (this.d.killSwitch()) {
      for (const a of running) {
        await this.d.repo.setRunning(a.account, false, "paused by the operator");
        await this.d.repo.recordEvent(a.account, "kill_switch", {}, this.d.now());
      }
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
          const reason = `stopped after ${n} errors: ${message}`;
          await this.d.repo.setRunning(a.account, false, reason);
          await this.d.repo.recordEvent(a.account, "error", { message: reason }, this.d.now());
        }
      }
    }
  }
}
