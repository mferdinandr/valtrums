// Browser-side parser: posts the prompt to the server route (which owns the optional model key) and validates the
// reply again, since the wire is not trusted. If the route cannot be reached the deterministic rules answer locally.

import { validateLifecycleIntent, type LifecycleIntentParser, type LifecycleParseResult } from "./lifecycle-intent";
import { lifecycleRuleParser } from "./lifecycle-rule-parser";

export function createLifecycleRouteParser(fetchImpl: typeof fetch = fetch, url = "/api/terminal/lifecycle"): LifecycleIntentParser {
  return {
    name: "route",
    async parse(prompt) {
      let body: { ok?: boolean; intent?: unknown; error?: unknown; clarify?: unknown };
      try {
        const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }) });
        body = (await res.json()) as typeof body;
      } catch {
        return lifecycleRuleParser.parse(prompt);
      }
      if (body.ok === true) return validateLifecycleIntent(body.intent);
      return {
        ok: false,
        error: typeof body.error === "string" ? body.error.slice(0, 300) : "The parser failed",
        ...(body.clarify === true ? { clarify: true } : {}),
      } satisfies LifecycleParseResult;
    },
  };
}
