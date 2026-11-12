// Browser-side parser: posts the prompt to the server route (which owns the optional model key) and validates the
// reply again, since the wire is not trusted. If the route cannot be reached the deterministic rules answer locally.

import { validateLifecycleIntent, type LifecycleIntentParser, type LifecycleParseResult } from "./lifecycle-intent";
import { parseRequests } from "./multi-request";
import { lifecycleRuleParser } from "./lifecycle-rule-parser";

export function createLifecycleRouteParser(fetchImpl: typeof fetch = fetch, url = "/api/terminal/lifecycle"): LifecycleIntentParser {
  return {
    name: "route",
    async parse(prompt) {
      // More than one request in a prompt is split and read locally; a single request goes to the route as before.
      const multi = await parseRequests(prompt);
      if (multi) return multi;
      let body: { ok?: boolean; intent?: unknown; error?: unknown; clarify?: unknown; parser?: unknown; note?: unknown };
      try {
        const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }) });
        body = (await res.json()) as typeof body;
      } catch {
        return lifecycleRuleParser.parse(prompt);
      }
      // Which parser answered, and why it was not the model when it was not (display only; never trusted for anything).
      const meta = {
        ...(typeof body.parser === "string" ? { via: body.parser.slice(0, 20) } : {}),
        ...(typeof body.note === "string" ? { note: body.note.slice(0, 300) } : {}),
      };
      if (body.ok === true) {
        const checked = validateLifecycleIntent(body.intent);
        return { ...checked, ...meta };
      }
      return {
        ok: false,
        error: typeof body.error === "string" ? body.error.slice(0, 300) : "The parser failed",
        ...(body.clarify === true ? { clarify: true } : {}),
        ...meta,
      } satisfies LifecycleParseResult;
    },
  };
}
