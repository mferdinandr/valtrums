// Deterministic rule-based parser (English and Indonesian). Used when no model key is configured and in tests.

import {
  DEFAULT_SLIPPAGE_BPS,
  MAX_PROMPT_CHARS,
  SUPPORTED_CHAINS,
  formatDecimal,
  normalizeChain,
  usdcUnits,
  validateIntent,
  type IntentParser,
  type IntentSource,
  type ParseResult,
} from "./intent";

const ACTION_RE =
  /\b(deposit|stake|bet|all[- ]?in|fund|join|back|support|taruh|setor|masukkan|masukin|pasang|dukung|ikut)\b/i;
const STOP_TOKENS = new Set(["TRIBE", "SIDE", "TEAM", "KUBU", "TIM", "SISI", "BATTLE", "THE", "MY", "A", "B", "ARENA", "USDC", "USD", "SAYA"]);
const SEPARATOR_RE = /[,;+&]|\b(?:and|dan|plus|lalu|then|serta)\b/gi;
const CHAIN_WORDS = [...SUPPORTED_CHAINS, "eth", "arb", "op", "bnb", "sol"];
const CHAIN_RE = new RegExp(`\\b(${CHAIN_WORDS.join("|")})\\b`, "i");

interface Mention {
  amount: string;
  start: number;
  end: number;
}

function clarify(error: string): ParseResult {
  return { ok: false, error, clarify: true };
}

/** Numbers that are really battle ids or slippage values are not funding amounts. */
function findAmounts(text: string, reserved: Array<[number, number]>): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (reserved.some(([a, b]) => start >= a && end <= b)) continue;
    if (/^\s*(%|bps)/i.test(text.slice(end))) continue;
    out.push({ amount: m[0], start, end });
  }
  return out;
}

function classify(text: string, mentions: Mention[], i: number): IntentSource | { kind: "plain"; amount: string } {
  const cur = mentions[i]!;
  const prevEnd = i > 0 ? mentions[i - 1]!.end : 0;
  const nextStart = i + 1 < mentions.length ? mentions[i + 1]!.start : text.length;

  const cut = (s: string, side: "head" | "tail"): string => {
    const parts = s.split(SEPARATOR_RE);
    return (side === "head" ? parts[0] : parts[parts.length - 1]) ?? "";
  };
  const trailing = cut(text.slice(cur.end, nextStart), "head");
  const leading = cut(text.slice(prevEnd, cur.start), "tail").split(/\s+/).slice(-4).join(" ");

  for (const ctx of [trailing, leading]) {
    if (/\b(credit|kredit)\b/i.test(ctx)) return { kind: "credit", amount: cur.amount };
    const chain = CHAIN_RE.exec(ctx);
    if (chain) return { kind: "other_chain", amount: cur.amount, chain: normalizeChain(chain[1]!)! };
    if (/\bnear\b/i.test(ctx)) return { kind: "near_wallet", amount: cur.amount };
  }
  return { kind: "plain", amount: cur.amount };
}

export function parseWithRules(prompt: string): ParseResult {
  const text = prompt.trim();
  if (text === "") return { ok: false, error: "Type what you want to do, e.g. \"Deposit 50 USDC to $WIF\"" };
  if (text.length > MAX_PROMPT_CHARS) return { ok: false, error: `Prompt is too long (max ${MAX_PROMPT_CHARS} characters)` };
  if (!ACTION_RE.test(text)) return { ok: false, error: "Only deposits are supported. Try \"Deposit 50 USDC to $WIF\"." };

  const reserved: Array<[number, number]> = [];

  let battle: number | undefined;
  const battleMatch = /(?:\bbattle|\barena|\bpertarungan|#)\s*#?\s*(\d+)/i.exec(text);
  if (battleMatch) {
    battle = Number(battleMatch[1]);
    const s = (battleMatch.index ?? 0) + battleMatch[0].lastIndexOf(battleMatch[1]!);
    reserved.push([s, s + battleMatch[1]!.length]);
  }

  let slippageBps = DEFAULT_SLIPPAGE_BPS;
  const slip =
    /slippage\s*(?:of|max|maks|maksimal|sebesar)?\s*(\d+(?:\.\d+)?)\s*(%|bps)?/i.exec(text) ??
    /(\d+(?:\.\d+)?)\s*(%|bps)\s*slippage/i.exec(text);
  if (slip) {
    const v = Number(slip[1]);
    slippageBps = Math.round(slip[2]?.toLowerCase() === "bps" ? v : v * 100);
    const s = (slip.index ?? 0) + slip[0].indexOf(slip[1]!);
    reserved.push([s, s + slip[1]!.length]);
  }

  // Token: an explicit $SYMBOL first, then a bare word after "to"/"ke".
  const dollarTokens = [...new Set([...text.matchAll(/\$([A-Za-z][A-Za-z0-9_]{0,19})\b/g)].map((m) => m[1]!.toUpperCase()))];
  if (dollarTokens.length > 1) return clarify(`Which one: ${dollarTokens.map((t) => "$" + t).join(" or ")}? Name a single token.`);
  let token = dollarTokens[0];
  if (!token) {
    const bare = /\b(?:to|into|on|for|ke|untuk)\s+([A-Za-z][A-Za-z0-9_]{1,19})\b/i.exec(text);
    const cand = bare?.[1]?.toUpperCase();
    if (cand && !STOP_TOKENS.has(cand)) token = cand;
  }

  let side: "A" | "B" | undefined;
  const sideMatch = /\b(?:tribe|side|team|kubu|tim|sisi)\s+([ab])\b/i.exec(text);
  if (sideMatch) side = sideMatch[1]!.toUpperCase() as "A" | "B";

  const mentions = findAmounts(text, reserved);
  if (mentions.length === 0) return clarify("How much USDC do you want to deposit?");

  const classified = mentions.map((_, i) => classify(text, mentions, i));
  const sources: IntentSource[] = [];
  const plain: string[] = [];
  for (const c of classified) {
    if (c.kind === "plain") plain.push(c.amount);
    else sources.push(c as IntentSource);
  }
  if (plain.length > 1) return clarify("I found several amounts without a funding source. Which one is the total?");

  const sumOf = (list: IntentSource[]) => list.reduce((acc, s) => acc + (usdcUnits(s.amount) ?? 0n), 0n);
  const sourcesSum = sumOf(sources);
  let totalUnits: bigint;
  if (plain.length === 1) {
    totalUnits = usdcUnits(plain[0]!) ?? 0n;
    const rest = totalUnits - sourcesSum;
    if (rest < 0n) return { ok: false, error: "The funding sources add up to more than the total amount." };
    if (rest > 0n) sources.push({ kind: "near_wallet", amount: formatDecimal(rest) });
  } else {
    totalUnits = sourcesSum;
  }

  // Merge duplicate (kind, chain) mentions so the validator's duplicate rule does not trip on e.g. two credit lines.
  const merged = new Map<string, IntentSource>();
  for (const s of sources) {
    const key = `${s.kind}:${s.chain ?? ""}`;
    const prev = merged.get(key);
    if (prev) prev.amount = formatDecimal((usdcUnits(prev.amount) ?? 0n) + (usdcUnits(s.amount) ?? 0n));
    else merged.set(key, { ...s, amount: formatDecimal(usdcUnits(s.amount) ?? 0n) });
  }

  const result = validateIntent({
    action: "deposit",
    battle,
    token,
    side,
    totalUsdc: formatDecimal(totalUnits),
    sources: [...merged.values()],
    slippageBps,
  });
  if (!result.ok && result.clarify) return clarify("Which battle or token do you want to back? Name it, e.g. $WIF.");
  return result;
}

export const ruleBasedParser: IntentParser = {
  name: "rules",
  async parse(prompt) {
    return parseWithRules(prompt);
  },
};
