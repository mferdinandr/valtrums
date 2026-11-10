import { STRATEGIES, type Option, type StrategyName } from "./strategy.js";

/**
 * An optional model (NEAR AI Cloud) that proposes the deposit. Its answer is untrusted text: the runner passes it to
 * the same validator as any proposal (`proposalToRequest`), which accepts exactly one JSON object with a fixed set of
 * fields. Only numbers and ids go into the prompt, never token names or descriptions, so token metadata cannot talk to
 * the model.
 */
export interface ModelInput {
  strategy: StrategyName;
  user: string;
  options: readonly Option[];
  maxAmount: bigint;
}
export interface ModelProposer {
  /** The model's raw answer, or null when it gave none. Never throws. */
  propose(input: ModelInput): Promise<string | null>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_MODEL_BASE_URL = "https://cloud-api.near.ai/v1";

export function buildPrompt(input: ModelInput): { system: string; user: string } {
  const rows = input.options.slice(0, 40).map((o) => `battleId=${o.battleId} community=${o.community} vault=${o.vault}`);
  return {
    system:
      "You are a player agent in a token-community arena. Answer with exactly one JSON object and nothing else: " +
      '{"action":"deposit","user":"<user>","battleId":<number>,"community":<number>,"amount":"<integer string>","rationale":"<short text>"}. ' +
      "Choose one of the listed options. The amount must be a positive integer not above the maximum.",
    user:
      `Strategy: ${STRATEGIES[input.strategy].description}\n` +
      `user=${input.user}\nmaxAmount=${input.maxAmount}\nOptions:\n${rows.join("\n")}`,
  };
}

export function createModelProposer(opts: { apiKey: string; model: string; baseUrl?: string; fetchImpl?: FetchLike; timeoutMs?: number }): ModelProposer {
  const doFetch: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const base = (opts.baseUrl ?? DEFAULT_MODEL_BASE_URL).replace(/\/+$/, "");
  return {
    async propose(input) {
      const { system, user } = buildPrompt(input);
      try {
        const res = await doFetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({ model: opts.model, temperature: 0, max_tokens: 300, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
        const content = body.choices?.[0]?.message?.content;
        return typeof content === "string" && content.trim() ? content : null;
      } catch {
        return null;
      }
    },
  };
}
