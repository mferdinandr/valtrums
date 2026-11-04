// Browser-side parser: posts the prompt to the server route, which owns the model key.

import { validateIntent, type IntentParser, type ParseResult } from "./intent";

export function createRouteParser(fetchImpl: typeof fetch = fetch, url = "/api/terminal/parse"): IntentParser {
  return {
    name: "route",
    async parse(prompt) {
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        const body = (await res.json()) as { ok?: boolean; intent?: unknown; error?: unknown; clarify?: unknown };
        if (body.ok === true) return validateIntent(body.intent); // validate again: never trust the wire
        return {
          ok: false,
          error: typeof body.error === "string" ? body.error : "The parser failed",
          ...(body.clarify === true ? { clarify: true } : {}),
        } satisfies ParseResult;
      } catch {
        return { ok: false, error: "Could not reach the parser" };
      }
    },
  };
}
