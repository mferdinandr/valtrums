import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { StrategyName } from "../player/strategy.js";

/** A hosted agent. The key is only ever stored as `encryptedKey` (see crypto.ts). */
export interface HostedAgent {
  /** The agent's implicit NEAR account. */
  account: string;
  publicKey: string;
  owner: string;
  encryptedKey: string;
  style: StrategyName;
  /** Send surplus tokens to the owner after each round. */
  sweep: boolean;
  keepWhole: number;
  running: boolean;
  createdAt: number;
  /** Why the agent stopped on its own (error or limit), or null. */
  lastError: string | null;
  /** NEAR AI calls made over the agent's life, for cost review. */
  modelCalls: number;
  /** When the key was exported, one entry per export. */
  exports: number[];
}

interface StoreData {
  version: 1;
  agents: Record<string, HostedAgent>;
}

/** A versioned JSON file with atomic writes. A malformed file stops the service instead of being reset. */
export class AgentStore {
  private data: StoreData;
  constructor(private readonly path: string | null) {
    if (path && existsSync(path)) {
      const v = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreData>;
      if (v.version !== 1 || typeof v.agents !== "object" || v.agents === null) throw new Error("hosted agent store is malformed");
      this.data = { version: 1, agents: v.agents };
    } else {
      this.data = { version: 1, agents: {} };
    }
  }
  get(account: string): HostedAgent | undefined {
    return this.data.agents[account];
  }
  all(): HostedAgent[] {
    return Object.values(this.data.agents);
  }
  byOwner(owner: string): HostedAgent[] {
    return this.all().filter((a) => a.owner === owner);
  }
  put(agent: HostedAgent): void {
    this.data.agents[agent.account] = agent;
    this.save();
  }
  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
