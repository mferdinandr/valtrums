import { z } from "zod";
import type { CustodyFacts } from "../custody-compat.js";

/**
 * Operator-configured custody paths for the health read (#148). Validated strictly; a malformed value fails
 * startup instead of silently enabling or hiding a path. These are asserted facts: the health read says so.
 */
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const pathSchema = z
  .object({
    label: z.string().min(1).max(64),
    depositContract: address,
    tokenHolder: address,
    payoutSender: address,
    holderCodeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable().default(null),
  })
  .strict();

export function loadCustodyPaths(raw: string): Array<CustodyFacts & { label: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ARENA_APPLICATION_CUSTODY_PATHS must be valid JSON");
  }
  const result = z.array(pathSchema).max(64).safeParse(parsed);
  if (!result.success) throw new Error("ARENA_APPLICATION_CUSTODY_PATHS must be an array of custody path objects");
  const labels = new Set<string>();
  for (const p of result.data) {
    if (labels.has(p.label)) throw new Error("ARENA_APPLICATION_CUSTODY_PATHS has a duplicate label");
    labels.add(p.label);
  }
  return result.data;
}
