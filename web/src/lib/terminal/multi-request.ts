// Several requests in one prompt: "deposit 2 CASHCAT and 2 VLAD in an open arena, then vote burn 50% on that battle if I win".
// Split deterministically and read each part with the built-in rules, so this costs nothing and a model never decides how
// many things get signed. If any part cannot be read, the caller falls back to reading the whole prompt as one request.

import { MAX_REQUESTS, type LifecycleIntent, type LifecycleParseResult } from "./lifecycle-intent";
import { lifecycleRuleParser } from "./lifecycle-rule-parser";

const SPLIT = /\s*(?:;|,|\bdan\b|\band\b|\blalu\b|\bthen\b|\bkemudian\b|\bterus\b|\bsetelah itu\b|\bafter that\b)\s*/i;
/** "if I win", "kalau menang": the vote can only happen once the battle is settled, and only winners can cast it. */
const CONDITION = /\s*\b(?:kalau|jika|bila|if|when|once)\s+(?:aku\s+|saya\s+|kita\s+|i\s+|we\s+)?(?:menang|win|won)\b/gi;
const BARE_AMOUNT = /^\s*\d+(?:\.\d+)?\s+\$?[a-z][a-z0-9._$-]*(?:\s|$)/i;
const DEPOSIT_VERB = /\b(deposit|depositkan|setor|setorkan|menyetor)\b/i;

/** Splits a prompt into requests. A part that is only "2 VLAD" repeats the deposit verb of the part before it. */
export function splitRequests(prompt: string): string[] | null {
  const text = prompt.trim().replace(/\s+/g, " ").replace(CONDITION, "");
  const parts = text.split(SPLIT).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  let verb: string | null = null;
  return parts.map((part) => {
    const found = DEPOSIT_VERB.exec(part)?.[1];
    if (found) verb = found;
    return !found && verb && BARE_AMOUNT.test(part) ? `${verb} ${part}` : part;
  });
}

export type MultiResult = LifecycleParseResult | null;

/**
 * The requests of a prompt that has more than one, or null when it is a single request (the caller then reads it as before).
 * More than MAX_REQUESTS is refused rather than cut, so nothing the user wrote is silently dropped.
 */
export async function parseRequests(prompt: string): Promise<MultiResult> {
  const parts = splitRequests(prompt);
  if (!parts) return null;
  const intents: LifecycleIntent[] = [];
  for (const part of parts) {
    const r = await lifecycleRuleParser.parse(part);
    if (!r.ok) return null;
    intents.push(r.intent);
  }
  if (intents.length > MAX_REQUESTS) return { ok: false, error: `That is ${intents.length} requests. Please send at most ${MAX_REQUESTS} at a time.` };
  const supported = intents.every((i) => (i.kind === "deposit" && i.community === null && i.tokenRef !== null) || i.kind === "dao_vote");
  if (!supported) return { ok: false, error: "In one prompt I can combine deposits by token and a vote. Send other requests separately." };
  return { ok: true, intent: intents[0]!, intents, via: "rules" };
}
