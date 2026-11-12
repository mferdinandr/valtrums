// Request handling for POST /api/terminal/lifecycle. Kept out of the route file so tests can inject a fake model fetch.
// The reply is only ever a validated intent; this route has no signing, no action proxy and no account access.
// Model use is bounded (`TerminalGuard`): a client over its limit, an exhausted budget or the kill switch makes the
// built-in rules answer, which cost nothing, and the reply says why.

import { MAX_PROMPT_CHARS, toWireIntent, validateLifecycleIntent, type LifecycleIntentParser, type LifecycleParseResult } from "./lifecycle-intent";
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL, createLifecycleLlmParser } from "./lifecycle-llm-parser";
import { lifecycleRuleParser } from "./lifecycle-rule-parser";
import type { TerminalGuard } from "./rate-limit";

export interface ParseRouteDeps {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** Limits on model use. Without one (tests) nothing is limited. */
  guard?: TerminalGuard;
  /** Who is asking, for the per-client limits. */
  client?: string;
}

/** The model parser, or null when no key is configured. The key and endpoint come from server-side env only. */
function modelParser({ env, fetchImpl }: ParseRouteDeps): LifecycleIntentParser | null {
  const apiKey = env.NEAR_AI_API_KEY?.trim();
  if (!apiKey) return null;
  return createLifecycleLlmParser({
    apiKey,
    baseUrl: env.NEAR_AI_BASE_URL?.trim() || DEFAULT_LLM_BASE_URL,
    model: env.NEAR_AI_MODEL?.trim() || DEFAULT_LLM_MODEL,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

/** Kept for callers that only need to know which parser would answer. */
export function selectLifecycleParser(deps: ParseRouteDeps): LifecycleIntentParser {
  return modelParser(deps) ?? lifecycleRuleParser;
}

type Reply = { status: number; body: Record<string, unknown> };

export async function handleLifecycleParse(req: Request, deps: ParseRouteDeps): Promise<Reply> {
  const { guard, client = "local" } = deps;
  // Every request counts, rules included, so a flood is refused before any work is done.
  if (guard && !guard.allowRequest(client)) {
    return { status: 429, body: { ok: false, error: "Too many requests. Wait a minute and try again." } };
  }
  let prompt: unknown;
  try {
    prompt = ((await req.json()) as { prompt?: unknown }).prompt;
  } catch {
    return { status: 400, body: { ok: false, error: "Invalid request" } };
  }
  if (typeof prompt !== "string" || prompt.length > MAX_PROMPT_CHARS * 2) return { status: 400, body: { ok: false, error: "Invalid prompt" } };

  const model = modelParser(deps);
  let result: LifecycleParseResult;
  let used = lifecycleRuleParser.name;
  let note: string | undefined;

  if (!model) {
    result = await lifecycleRuleParser.parse(prompt);
    note = "NEAR AI is not configured on this server (no NEAR_AI_API_KEY); the built-in rules answered";
  } else {
    const decision = guard ? guard.tryAi(client) : ({ allowed: true, release: () => undefined } as const);
    if (!decision.allowed) {
      result = await lifecycleRuleParser.parse(prompt);
      note = `${decision.reason.charAt(0).toUpperCase()}${decision.reason.slice(1)}; the built-in rules answered`;
    } else {
      try {
        result = await model.parse(prompt);
        used = model.name;
      } finally {
        decision.release();
      }
      // A model outage or a rejected reply falls back to the rules rather than leaving the user stuck.
      if (!result.ok && !result.clarify) {
        const fallback = await lifecycleRuleParser.parse(prompt);
        if (fallback.ok || fallback.clarify) {
          note = `NEAR AI could not answer (${result.error}); the built-in rules answered`;
          result = fallback;
          used = lifecycleRuleParser.name;
        }
      }
    }
  }

  // Defence in depth: the body that leaves this route is re-validated, whichever parser produced it.
  if (result.ok) {
    const wire = toWireIntent(result.intent);
    const checked = validateLifecycleIntent(wire);
    if (!checked.ok) return { status: 200, body: { ...checked, parser: used, ...(note ? { note } : {}) } };
    return { status: 200, body: { ok: true, intent: wire, parser: used, ...(note ? { note } : {}) } };
  }
  return { status: 200, body: { ...result, parser: used, ...(note ? { note } : {}) } };
}
