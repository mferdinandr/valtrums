// Request handling for POST /api/terminal/lifecycle. Kept out of the route file so tests can inject a fake model fetch.
// The reply is only ever a validated intent; this route has no signing, no action proxy and no account access.

import { MAX_PROMPT_CHARS, toWireIntent, validateLifecycleIntent, type LifecycleIntentParser, type LifecycleParseResult } from "./lifecycle-intent";
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL, createLifecycleLlmParser } from "./lifecycle-llm-parser";
import { lifecycleRuleParser } from "./lifecycle-rule-parser";

export interface ParseRouteDeps {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/** Model key and endpoint come from server-side env only. Without a key the deterministic parser answers. */
export function selectLifecycleParser({ env, fetchImpl }: ParseRouteDeps): LifecycleIntentParser {
  const apiKey = env.NEAR_AI_API_KEY?.trim();
  if (!apiKey) return lifecycleRuleParser;
  return createLifecycleLlmParser({
    apiKey,
    baseUrl: env.NEAR_AI_BASE_URL?.trim() || DEFAULT_LLM_BASE_URL,
    model: env.NEAR_AI_MODEL?.trim() || DEFAULT_LLM_MODEL,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

export async function handleLifecycleParse(req: Request, deps: ParseRouteDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  const env = deps.env;
  let prompt: unknown;
  try {
    prompt = ((await req.json()) as { prompt?: unknown }).prompt;
  } catch {
    return { status: 400, body: { ok: false, error: "Invalid request" } };
  }
  if (typeof prompt !== "string" || prompt.length > MAX_PROMPT_CHARS * 2) return { status: 400, body: { ok: false, error: "Invalid prompt" } };
  const parser = selectLifecycleParser(deps);
  let result: LifecycleParseResult = await parser.parse(prompt);
  let used = parser.name;
  let note: string | undefined;
  if (parser === lifecycleRuleParser && !env.NEAR_AI_API_KEY?.trim()) note = "NEAR AI is not configured on this server (no NEAR_AI_API_KEY); the built-in rules answered";
  // A model outage or a rejected reply falls back to the rules rather than leaving the user stuck.
  if (!result.ok && !result.clarify && parser !== lifecycleRuleParser) {
    const fallback = await lifecycleRuleParser.parse(prompt);
    if (fallback.ok || fallback.clarify) {
      note = `NEAR AI could not answer (${result.error}); the built-in rules answered`;
      result = fallback;
      used = lifecycleRuleParser.name;
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
