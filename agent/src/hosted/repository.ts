import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validatePlayerState, type PlayerStateData } from "../player/state.js";
import { AgentStore, type HostedAgent } from "./store.js";

export type EventKind = "create" | "start" | "stop" | "error" | "export" | "kill_switch";

/**
 * Everything the hosted service stores about agents. Two implementations: files (tests and local use without a
 * database) and Postgres (`pg-store.ts`). All methods are async so the manager does not care which one it has.
 */
export interface HostedRepository {
  get(account: string): Promise<HostedAgent | undefined>;
  byOwner(owner: string): Promise<HostedAgent[]>;
  running(): Promise<HostedAgent[]>;
  /** Inserts the agent unless its owner already has `maxPerOwner`; atomic. False means over the limit. */
  create(agent: HostedAgent, maxPerOwner: number): Promise<boolean>;
  setRunning(account: string, running: boolean, lastError: string | null): Promise<void>;
  incrementModelCalls(account: string): Promise<void>;
  recordEvent(account: string, kind: EventKind, detail?: Record<string, unknown>, at?: number): Promise<void>;
  /** The saved play state of an agent, or null when it has none yet. Malformed state throws. */
  loadState(account: string): Promise<PlayerStateData | null>;
  saveState(account: string, data: PlayerStateData): Promise<void>;
}

/** The file implementation: `agents.json` plus one `state-<account>.json` per agent under `stateDir`. */
export class FileHostedRepository implements HostedRepository {
  constructor(private readonly store: AgentStore, private readonly stateDir: string | null) {}

  async get(account: string) {
    return this.store.get(account);
  }
  async byOwner(owner: string) {
    return this.store.byOwner(owner);
  }
  async running() {
    return this.store.all().filter((a) => a.running);
  }
  async create(agent: HostedAgent, maxPerOwner: number) {
    if (this.store.byOwner(agent.owner).length >= maxPerOwner) return false;
    this.store.put(agent);
    return true;
  }
  async setRunning(account: string, running: boolean, lastError: string | null) {
    const a = this.store.get(account);
    if (a) this.store.put({ ...a, running, lastError });
  }
  async incrementModelCalls(account: string) {
    const a = this.store.get(account);
    if (a) this.store.put({ ...a, modelCalls: a.modelCalls + 1 });
  }
  async recordEvent(account: string, kind: EventKind, _detail?: Record<string, unknown>, at?: number) {
    // The file store keeps only the export times (it has no event log).
    const a = this.store.get(account);
    if (a && kind === "export") this.store.put({ ...a, exports: [...a.exports, at ?? Date.now()] });
  }
  async loadState(account: string) {
    const path = this.statePath(account);
    return path && existsSync(path) ? validatePlayerState(JSON.parse(readFileSync(path, "utf8"))) : null;
  }
  async saveState(account: string, data: PlayerStateData) {
    const path = this.statePath(account);
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  }
  private statePath(account: string): string | null {
    return this.stateDir ? `${this.stateDir}/state-${account}.json` : null;
  }
}
