import { readFileSync } from "node:fs";
import type { DelegateGrants } from "../mcp/actions/proposal.js";
import { isStrategyName, type StrategyName } from "./strategy.js";

/** One player agent: who it acts for, under which grant, and how it chooses. Keys are never in this file. */
export interface PlayerAgentConfig {
  /** The agent's own NEAR account (the grant's delegate). */
  delegate: string;
  /** The user whose funds and position the grant covers. */
  user: string;
  /** 32-byte grant local id, lowercase hex. */
  localId: string;
  mappingVersion: string;
  strategy: StrategyName;
  /** `rule` decides deterministically; `model` asks NEAR AI and validates the answer like any proposal. */
  mode: "rule" | "model";
  /** Share of the remaining budget one action may use, in basis points. */
  fractionBps: number;
  /** Most reservations per hour. */
  maxPerHour: number;
  /** Stop after this many failures in a row. */
  maxFailures: number;
  intervalSecs: number;
  /** How many of the latest battles to look at. */
  scanBattles: number;
  /** Name of the environment variable that holds this agent's `ed25519:` key. */
  keyEnv: string;
}

const ACCOUNT = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;
const KEY_ENV = /^[A-Z][A-Z0-9_]{2,63}$/;
const int = (v: unknown, def: number, min: number, max: number, what: string): number => {
  const n = v === undefined ? def : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new Error(`${what} must be an integer from ${min} to ${max}`);
  return n;
};

export function parsePlayerAgents(raw: unknown): PlayerAgentConfig[] {
  const list = (raw as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(list) || list.length === 0) throw new Error("player agent config needs a non-empty `agents` list");
  const seen = new Set<string>();
  return list.map((a, i): PlayerAgentConfig => {
    const x = (a ?? {}) as Record<string, unknown>;
    const at = `agents[${i}]`;
    const delegate = String(x.delegate ?? "");
    const user = String(x.user ?? "");
    if (!ACCOUNT.test(delegate)) throw new Error(`${at}.delegate must be a NEAR account id`);
    if (!ACCOUNT.test(user)) throw new Error(`${at}.user must be a NEAR account id`);
    if (delegate === user) throw new Error(`${at}: the agent account must differ from the user`);
    if (typeof x.localId !== "string" || !/^[0-9a-f]{64}$/.test(x.localId)) throw new Error(`${at}.localId must be 32 bytes of lowercase hex`);
    if (typeof x.keyEnv !== "string" || !KEY_ENV.test(x.keyEnv)) throw new Error(`${at}.keyEnv must name an environment variable; keys never go in this file`);
    if (!isStrategyName(x.strategy)) throw new Error(`${at}.strategy must be crowd or underdog`);
    if (x.mode !== undefined && x.mode !== "rule" && x.mode !== "model") throw new Error(`${at}.mode must be rule or model`);
    const mappingVersion = x.mappingVersion === undefined ? "1" : String(x.mappingVersion);
    if (!/^[1-9][0-9]{0,19}$/.test(mappingVersion)) throw new Error(`${at}.mappingVersion must be a positive integer`);
    const key = `${delegate}:${user}:${x.localId}`;
    if (seen.has(key)) throw new Error(`${at} repeats another agent`);
    seen.add(key);
    return {
      delegate, user, localId: x.localId, mappingVersion, strategy: x.strategy, mode: (x.mode as "rule" | "model" | undefined) ?? "rule",
      fractionBps: int(x.fractionBps, 2_500, 1, 10_000, `${at}.fractionBps`),
      maxPerHour: int(x.maxPerHour, 6, 1, 120, `${at}.maxPerHour`),
      maxFailures: int(x.maxFailures, 3, 1, 20, `${at}.maxFailures`),
      intervalSecs: int(x.intervalSecs, 60, 10, 3_600, `${at}.intervalSecs`),
      scanBattles: int(x.scanBattles, 20, 1, 200, `${at}.scanBattles`),
      keyEnv: x.keyEnv,
    };
  });
}

export function loadPlayerAgents(path: string, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): PlayerAgentConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(path));
  } catch {
    throw new Error("player agent config is not readable JSON");
  }
  return parsePlayerAgents(parsed);
}

/** The grants each delegate may use, taken from operator configuration only (never from a proposal). */
export function delegateGrantsOf(agents: readonly PlayerAgentConfig[]): DelegateGrants {
  const out: Record<string, Array<{ user: string; localId: string; mappingVersion: string }>> = {};
  for (const a of agents) (out[a.delegate] ??= []).push({ user: a.user, localId: a.localId, mappingVersion: a.mappingVersion });
  return out;
}

/** The agent's key from its named environment variable. Errors name the variable, never its value. */
export function keyFor(agent: PlayerAgentConfig, env: Record<string, string | undefined>): string {
  const key = env[agent.keyEnv]?.trim();
  if (!key) throw new Error(`missing key: set ${agent.keyEnv}`);
  if (!key.startsWith("ed25519:")) throw new Error(`${agent.keyEnv} must be an ed25519:... key`);
  return key;
}
