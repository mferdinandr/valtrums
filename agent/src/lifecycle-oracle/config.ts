import { readFileSync } from "node:fs";
import { z } from "zod";
import { namespaceSchema, MODES, type Mode, type ObservationNamespace } from "../observations/schema.js";
import { DISPLAYABLE_MODES } from "../observations/query.js";

/**
 * Process configuration of the lifecycle oracle (OpenSpec arena-testnet-integrations, issue #147).
 * The oracle is its own role: it holds only the dedicated oracle account key and refuses to start when
 * any other role's credentials (the arena agent, payout relayer or operator) are in its environment.
 * Writes are off unless ORACLE_WRITES_ENABLED=true, so a first start only reports what it would do.
 * Error messages name variables, never values.
 */

export const EVIDENCE_KINDS = ["fixture", "recorded", "live"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Terms revealed with `start_lifecycle_rounds`; they must hash to the policy frozen at lock. */
export const termsSchema = z
  .object({
    source: z.string().min(1).max(256),
    quote_currency: z.string().min(1).max(32),
    eligible_pools: z.array(z.string().min(1).max(128)).min(1).max(64),
    finality: z.string().min(1).max(64),
    price_decimals: z.number().int().min(0).max(36),
    supply_decimals: z.number().int().min(0).max(36),
    volume_decimals: z.number().int().min(0).max(36),
    boundary_tolerance_ns: z.string().regex(/^[1-9][0-9]*$/),
    max_gap_ns: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();
export type ObservationTerms = z.infer<typeof termsSchema>;

export interface OracleConfig {
  network: "testnet" | "mainnet";
  rpcUrl: string;
  arenaContractId: string;
  accountId: string;
  /** Secret. Never log or serialize this value. */
  privateKey: string;
  writesEnabled: boolean;
  intervalSecs: number;
  stateDir: string;
  journalDir: string;
  scope: ObservationNamespace;
  /** Reveal terms by frozen policy hash. A battle whose hash is absent here is held, never guessed. */
  terms: ReadonlyMap<string, ObservationTerms>;
  /** Evidence source kinds that may resolve a round. Live only, unless a sandbox deployment says otherwise. */
  evidenceKinds: ReadonlySet<EvidenceKind>;
  qualifiedModes: ReadonlySet<Mode>;
  /** Storage deposit attached to `start_lifecycle_rounds`; null means the oracle never spends it. */
  roundsStorageDepositYocto: string | null;
}

const FORBIDDEN = [
  "AGENT_PRIVATE_KEY", "AGENT_PRIVATE_KEY_FILE",
  "PAYOUT_RELAYER_PRIVATE_KEY", "PAYOUT_RELAYER_PRIVATE_KEY_FILE", "PAYOUT_OPERATOR_PRIVATE_KEY", "PAYOUT_OPERATOR_PRIVATE_KEY_FILE",
];

export function loadOracleConfig(env: Record<string, string | undefined>, readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): OracleConfig {
  for (const name of FORBIDDEN) {
    if (env[name] !== undefined && env[name] !== "") throw new Error(`${name} must not be set in the lifecycle oracle process; remove it`);
  }
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`missing required environment variable ${name}`);
    return v;
  };
  const network = env.NEAR_NETWORK?.trim() || "testnet";
  if (network !== "testnet" && network !== "mainnet") throw new Error('NEAR_NETWORK must be "testnet" or "mainnet"');
  const direct = env.ORACLE_PRIVATE_KEY?.trim();
  const file = env.ORACLE_PRIVATE_KEY_FILE?.trim();
  if (direct && file) throw new Error("set only one of ORACLE_PRIVATE_KEY and ORACLE_PRIVATE_KEY_FILE");
  if (!direct && !file) throw new Error("missing key: set ORACLE_PRIVATE_KEY or ORACLE_PRIVATE_KEY_FILE");
  let privateKey = direct;
  if (!privateKey) {
    try { privateKey = readFile(file as string).trim(); }
    catch (err) { throw new Error(`cannot read ORACLE_PRIVATE_KEY_FILE${(err as NodeJS.ErrnoException).code ? ` (${(err as NodeJS.ErrnoException).code})` : ""}`); }
  }
  if (!privateKey || !privateKey.startsWith("ed25519:")) throw new Error("the oracle private key must be an ed25519:... key");
  const writes = env.ORACLE_WRITES_ENABLED?.trim();
  if (writes !== undefined && writes !== "" && writes !== "true" && writes !== "false") throw new Error('ORACLE_WRITES_ENABLED must be "true" or "false"');
  const interval = Number(env.ORACLE_INTERVAL_SECS?.trim() || "5");
  if (!Number.isInteger(interval) || interval < 1 || interval > 20) throw new Error("ORACLE_INTERVAL_SECS must be an integer from 1 to 20 (rounds last 30 seconds)");

  let scope: ObservationNamespace;
  try { scope = namespaceSchema.parse(JSON.parse(need("ARENA_APPLICATION_OBSERVATION_SCOPE"))); }
  catch { throw new Error("ARENA_APPLICATION_OBSERVATION_SCOPE must be a valid deployment namespace JSON"); }
  const arena = need("ARENA_CONTRACT_ID");
  if (scope.arenaContract !== arena) throw new Error("ARENA_APPLICATION_OBSERVATION_SCOPE names another arena contract than ARENA_CONTRACT_ID");
  if (scope.protocol !== "lifecycle-v2" || scope.network !== `near-${network}`) throw new Error("ARENA_APPLICATION_OBSERVATION_SCOPE must be a lifecycle-v2 namespace of NEAR_NETWORK");

  const terms = new Map<string, ObservationTerms>();
  const termsPath = env.ORACLE_TERMS_PATH?.trim();
  if (termsPath) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFile(termsPath)); } catch { throw new Error("ORACLE_TERMS_PATH must be readable JSON"); }
    const shape = z.record(z.string().min(1).max(128), termsSchema).safeParse(parsed);
    if (!shape.success) throw new Error("ORACLE_TERMS_PATH must map frozen policy hashes to observation terms");
    for (const [hash, t] of Object.entries(shape.data)) terms.set(hash, t);
  }

  const kinds = new Set<EvidenceKind>();
  for (const raw of (env.ORACLE_EVIDENCE_KINDS?.trim() || "live").split(",").map((k) => k.trim()).filter(Boolean)) {
    if (!(EVIDENCE_KINDS as readonly string[]).includes(raw)) throw new Error(`ORACLE_EVIDENCE_KINDS has an unknown kind: ${raw}`);
    kinds.add(raw as EvidenceKind);
  }
  if (kinds.size === 0) throw new Error("ORACLE_EVIDENCE_KINDS must name at least one kind");
  if (network === "mainnet" && (kinds.has("fixture") || kinds.has("recorded"))) throw new Error("fixture and recorded evidence can never resolve a mainnet round");

  const qualified = new Set<Mode>();
  for (const raw of (env.OBSERVATION_QUALIFIED_MODES?.trim() ?? "").split(",").map((m) => m.trim()).filter(Boolean)) {
    if (!(MODES as readonly string[]).includes(raw)) throw new Error(`OBSERVATION_QUALIFIED_MODES has an unknown mode: ${raw}`);
    if (!DISPLAYABLE_MODES.includes(raw as Mode)) throw new Error(`OBSERVATION_QUALIFIED_MODES cannot enable ${raw}: it needs exact supply or interval-trade evidence`);
    qualified.add(raw as Mode);
  }
  const deposit = env.ORACLE_ROUNDS_STORAGE_DEPOSIT_YOCTO?.trim();
  if (deposit && !/^[1-9][0-9]{0,38}$/.test(deposit)) throw new Error("ORACLE_ROUNDS_STORAGE_DEPOSIT_YOCTO must be a positive integer of yoctoNEAR");

  return {
    network, rpcUrl: env.NEAR_RPC_URL?.trim() || `https://rpc.${network}.near.org`, arenaContractId: arena,
    accountId: need("ORACLE_ACCOUNT_ID"), privateKey, writesEnabled: writes === "true", intervalSecs: interval,
    stateDir: need("ORACLE_STATE_DIR"), journalDir: need("OBSERVATION_JOURNAL_DIR"), scope, terms, evidenceKinds: kinds, qualifiedModes: qualified,
    roundsStorageDepositYocto: deposit || null,
  };
}
