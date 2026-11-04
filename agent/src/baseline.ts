import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Liquidity (USD) per token at the moment a battle was approved. */
export type Baseline = Record<string, number>;

/**
 * Where watchdog baselines live. The contract has no field for them, so this
 * is local state. Limitation: if the state is lost (new machine, deleted
 * file), the watchdog re-derives a baseline from the current liquidity, which
 * hides any drop that happened before the restart.
 */
export interface BaselineStore {
  get(battleId: number): Promise<Baseline | undefined>;
  set(battleId: number, baseline: Baseline): Promise<void>;
}

export class InMemoryBaselineStore implements BaselineStore {
  private readonly data = new Map<number, Baseline>();

  async get(battleId: number): Promise<Baseline | undefined> {
    const b = this.data.get(battleId);
    return b ? { ...b } : undefined;
  }

  async set(battleId: number, baseline: Baseline): Promise<void> {
    this.data.set(battleId, { ...baseline });
  }
}

export const DEFAULT_BASELINE_PATH = "./.agent-state/baselines.json";

/** JSON file store. Writes are atomic (temp file then rename). A missing file is an empty store. */
export class JsonFileBaselineStore implements BaselineStore {
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string = DEFAULT_BASELINE_PATH) {}

  private async load(): Promise<Record<string, Baseline>> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, Baseline>;
      }
      return {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      if (err instanceof SyntaxError) return {}; // corrupt file: treated as lost state
      throw err;
    }
  }

  async get(battleId: number): Promise<Baseline | undefined> {
    return (await this.load())[String(battleId)];
  }

  set(battleId: number, baseline: Baseline): Promise<void> {
    const run = async () => {
      const all = await this.load();
      all[String(battleId)] = baseline;
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(all, null, 2), "utf8");
      await rename(tmp, this.path);
    };
    // Serialize writers so concurrent sets do not lose each other's entries.
    this.writing = this.writing.then(run, run);
    return this.writing;
  }
}
