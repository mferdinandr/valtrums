import { NextResponse } from "next/server";
import { MAX_PROMPT_CHARS, type IntentParser } from "@/lib/terminal/intent";
import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL, createLlmParser } from "@/lib/terminal/llm-parser";
import { ruleBasedParser } from "@/lib/terminal/rule-parser";

export const dynamic = "force-dynamic";

/** Model key and endpoint come from server-side env only. Without a key the deterministic parser answers. */
function selectParser(): IntentParser {
  const apiKey = process.env.NEAR_AI_API_KEY?.trim();
  if (!apiKey) return ruleBasedParser;
  return createLlmParser({
    apiKey,
    baseUrl: process.env.NEAR_AI_BASE_URL?.trim() || DEFAULT_LLM_BASE_URL,
    model: process.env.NEAR_AI_MODEL?.trim() || DEFAULT_LLM_MODEL,
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  let prompt: unknown;
  try {
    prompt = ((await req.json()) as { prompt?: unknown }).prompt;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
  if (typeof prompt !== "string" || prompt.length > MAX_PROMPT_CHARS * 2) {
    return NextResponse.json({ ok: false, error: "Invalid prompt" }, { status: 400 });
  }
  const parser = selectParser();
  let result = await parser.parse(prompt);
  // A model outage or a rejected reply falls back to the rules rather than leaving the user stuck.
  if (!result.ok && !result.clarify && parser !== ruleBasedParser) {
    const fallback = await ruleBasedParser.parse(prompt);
    if (fallback.ok || fallback.clarify) result = fallback;
  }
  return NextResponse.json({ ...result, parser: parser.name });
}
