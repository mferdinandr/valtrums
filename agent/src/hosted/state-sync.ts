import { PlayerState, type PlayerStateData } from "../player/state.js";
import type { HostedRepository } from "./repository.js";

/**
 * Per-agent play state backed by the repository. The agent loop stays synchronous: `PlayerState` hands each change to
 * this class, which keeps the latest copy and writes it on `flush`. A failed write stays pending and is retried on the
 * next flush, and the failure is thrown so the round is reported as an error (the state is never silently dropped).
 */
export class AgentStates {
  private readonly states = new Map<string, PlayerState>();
  private readonly pending = new Map<string, PlayerStateData>();
  constructor(private readonly repo: HostedRepository) {}

  async state(account: string): Promise<PlayerState> {
    const known = this.states.get(account);
    if (known) return known;
    const data = await this.repo.loadState(account); // malformed state throws here: the agent does not play
    const state = new PlayerState(null, { ...(data ? { data } : {}), onSave: (d) => void this.pending.set(account, d) });
    this.states.set(account, state);
    return state;
  }

  /** Writes the latest unsaved state of an agent, if any. Throws when the write fails. */
  async flush(account: string): Promise<void> {
    const data = this.pending.get(account);
    if (!data) return;
    await this.repo.saveState(account, data);
    if (this.pending.get(account) === data) this.pending.delete(account);
  }

  /** True when an agent has state that could not be saved yet. */
  dirty(account: string): boolean {
    return this.pending.has(account);
  }
}
