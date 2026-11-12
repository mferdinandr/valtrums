/**
 * A short in-memory log of what each hosted agent did, for its owner to read. It is fed by the events the play loop
 * already emits, keeps only a few harmless fields (never a key, a signature or free text from a model), and holds the
 * latest entries per agent. It is not stored: a restart of the service starts the log empty.
 */
export interface ActivityEntry {
  at: number;
  event: string;
  battleId?: number;
  community?: number;
  burnPercent?: number;
  amount?: string;
  token?: string;
  step?: string;
  decidedBy?: string;
  txHash?: string;
  reason?: string;
  message?: string;
}

/** The events worth showing an owner. Everything else the loop emits stays in the service log only. */
const SHOWN = new Set(["start", "stop", "skipped", "no_option", "model_answer_rejected", "sent", "played", "error", "sweep_skipped", "swept", "claimed", "claim_error", "voted", "vote_error", "vote_skipped"]);
const MAX_PER_AGENT = 50;
const text = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) ? v : undefined);

export class ActivityLog {
  private readonly byAgent = new Map<string, ActivityEntry[]>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Records one loop event for the agent named in it (`agent`), or for `account` when given. Unknown events are ignored. */
  note(event: Record<string, unknown>, account?: string): void {
    const who = account ?? text(event.agent, 80);
    const kind = text(event.event, 40);
    if (!who || !kind || !SHOWN.has(kind)) return;
    const entry: ActivityEntry = { at: this.now(), event: kind };
    const battleId = num(event.battleId);
    const community = num(event.community);
    if (battleId !== undefined) entry.battleId = battleId;
    if (community !== undefined) entry.community = community;
    const burnPercent = num(event.burnPercent);
    if (burnPercent !== undefined && burnPercent >= 0 && burnPercent <= 100) entry.burnPercent = burnPercent;
    for (const key of ["amount", "token", "step", "decidedBy", "txHash", "reason", "message"] as const) {
      const v = text(event[key]);
      if (v !== undefined) entry[key] = v;
    }
    const list = this.byAgent.get(who) ?? [];
    // The loop repeats the same "nothing to do" every round; one line per change is enough.
    const last = list[list.length - 1];
    if (last && last.event === entry.event && last.reason === entry.reason && last.message === entry.message && last.battleId === entry.battleId && last.step === entry.step) return;
    list.push(entry);
    if (list.length > MAX_PER_AGENT) list.splice(0, list.length - MAX_PER_AGENT);
    this.byAgent.set(who, list);
  }

  /** Newest first. */
  recent(account: string): ActivityEntry[] {
    return [...(this.byAgent.get(account) ?? [])].reverse();
  }
}
