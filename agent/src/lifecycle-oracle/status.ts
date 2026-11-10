import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Non-authoritative status of the lifecycle oracle: what it saw, did and is waiting for. Authority stays
 * with the arena contract; if this file is lost the oracle re-derives everything from contract state and
 * persisted observation evidence. It carries no secret and no key material.
 */
export const STATUS_SCHEMA = "lifecycle-oracle-status-v1" as const;
export const MAX_STATUS_BATTLES = 50;

export type Phase =
  | "not_locked" | "done" | "blocked" | "needs_rounds_started" | "needs_open" | "window_open" | "ready_to_resolve" | "pending_evidence" | "error";

export interface BattleStatus {
  battleId: string;
  phase: Phase;
  roundId: string | null;
  /** Specific, non-secret reasons the oracle is holding or blocked. */
  reasons: string[];
  /** Writes it performed this pass, or would perform when writes are disabled. */
  actions: Array<{ action: "start_lifecycle_rounds" | "open_lifecycle_round" | "submit_lifecycle_observations"; executed: boolean; outcome: string | null }>;
  lastError: string | null;
  updatedAtMs: string;
}

export interface OracleStatus {
  schema: typeof STATUS_SCHEMA;
  updatedAtMs: string;
  writesEnabled: boolean;
  accountId: string;
  contract: string;
  passes: number;
  /** Set when the latest pass could not even read the chain; individual battle rows may then be old. */
  passError: string | null;
  battles: Record<string, BattleStatus>;
}

export class OracleLockedError extends Error {
  constructor() {
    super("lifecycle oracle state directory is locked by another process; stop it before removing oracle.lock");
    this.name = "OracleLockedError";
  }
}

/** Single-process guard plus atomic status file. The lock is never stolen by age. */
export class OracleStateDir {
  private constructor(private readonly dir: string) {}

  static async open(dir: string): Promise<OracleStateDir> {
    await mkdir(dir, { recursive: true });
    try {
      const h = await open(join(dir, "oracle.lock"), "wx");
      await h.close();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new OracleLockedError();
      throw err;
    }
    return new OracleStateDir(dir);
  }

  async write(status: OracleStatus): Promise<void> {
    const path = join(this.dir, "status.json");
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(status), "utf8");
    await rename(tmp, path);
  }

  async close(): Promise<void> {
    await unlink(join(this.dir, "oracle.lock")).catch(() => undefined);
  }
}

/** Read-only load for the application health read. Throws when missing or malformed: never reported as healthy. */
export async function loadOracleStatus(dir: string): Promise<OracleStatus> {
  const parsed = JSON.parse(await readFile(join(dir, "status.json"), "utf8")) as OracleStatus;
  if (parsed?.schema !== STATUS_SCHEMA || typeof parsed.updatedAtMs !== "string" || typeof parsed.battles !== "object") throw new Error("oracle status is malformed");
  return parsed;
}
