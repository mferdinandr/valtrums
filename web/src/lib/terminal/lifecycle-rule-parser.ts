// Deterministic parser for lifecycle prompts in English and Bahasa Indonesia. No network, no model. Whatever it
// returns still goes through `validateLifecycleIntent`, so it can never produce something the boundary would refuse.

import {
  MAX_PROMPT_CHARS,
  validateLifecycleIntent,
  type LifecycleIntentParser,
  type LifecycleParseResult,
} from "./lifecycle-intent";

const clarify = (error: string): LifecycleParseResult => ({ ok: false, error, clarify: true });
const fail = (error: string): LifecycleParseResult => ({ ok: false, error });

const PAYOUT = /\b(payout|pay out|withdraw|withdrawal|claim|tarik|penarikan|cairkan|klaim)\b/;
const CREATE = /\b(create|make|new|start|launch|buat|bikin|bikinkan|buatkan|mulai)\b/;
const BATTLE_WORD = /\b(battle|arena|duel|pertarungan)\b/;
const REGISTER = /\b(register|registration|sign up|signup|join|daftar|mendaftar|daftarkan|registrasi|gabung|ikut)\b/;
const DEPOSIT = /\b(deposit|depositkan|setor|setorkan|menyetor|top up|topup)\b/;
const JOIN = /\b(join|gabung|bergabung|ikut)\b/;
const CANCEL = /\b(cancel|batalkan|membatalkan|batal)\b/;
const REFUND = /\b(refund|pengembalian dana|kembalikan dana|uang kembali)\b/;
/** "with CASHCAT", "dengan $WALLET", "pakai token GOOD": the token reference after the joiner word. */
const JOIN_TOKEN = /\b(?:with|using|dengan|pakai|memakai|menggunakan)\s+(?:token\s+)?(\$?[a-z0-9][a-z0-9._$-]{0,79})/;
const START_IN = /\b(?:in|dalam|mulai|start(?:s|ing)?(?:\s+in)?)\s+(\d{1,5})\s*(minutes?|mins?|m|menit|hours?|hrs?|h|jam|days?|d|hari)\b/;

const BATTLE_ID = /\b(?:battle|arena|duel|pertarungan)\s*(?:ke-?|no\.?|number|nomor)?\s*#?\s*([0-9]+)\b/;
const COMMUNITY_NO = /\b(?:community|communities|komunitas|crew|kubu|tim)\s*(?:ke-?|no\.?|number|nomor)?\s*#?\s*([0-9]+)\b/;
const ADDRESS = /0x[0-9a-f]{40}\b/;

const MODES: Array<[RegExp, string]> = [
  [/(price\s*(?:%\s*)?gain|price climb|harga naik|kenaikan harga|price)/, "PriceGain"],
  [/(market\s*-?cap(?:italization)?\s*(?:%\s*)?(?:growth|gain)?|mcap|kapitalisasi pasar|pertumbuhan komunitas)/, "MarketCapGrowth"],
  [/(volume\s*(?:-?to-?\s*market\s*-?cap)?\s*(?:ratio)?|rasio volume|trading energy)/, "VolumeRatio"],
  [/(lowest\s*(?:%\s*)?drawdown|drawdown|penurunan terendah|steadiest)/, "LowestDrawdown"],
];

/** The first whitespace-delimited token after a keyword, skipping filler such as "sebesar" / "of" / "units". */
function amountAfter(text: string, keywords: RegExp): string | null {
  const m = new RegExp(`${keywords.source}\\s+(?:sebesar\\s+|of\\s+|amount\\s+|jumlah\\s+)?(\\S+)`).exec(text);
  const token = m?.[m.length - 1];
  if (!token || /^(ke|to|into|di|in|on|for|untuk|battle|arena|komunitas|community|crew)$/.test(token)) return null;
  return token;
}

function amountOf(text: string, keywords: RegExp): { amount: string } | LifecycleParseResult {
  const token = amountAfter(text, keywords) ?? new RegExp("(?:sebesar|amount|jumlah)\\s+(\\S+)").exec(text)?.[1] ?? null;
  if (token === null) return clarify("How much? Give an exact whole number in token base units, for example 250.");
  if (!/^[1-9][0-9]{0,38}$/.test(token)) {
    return fail("The amount must be a positive whole number of base units in plain digits (no decimals, separators, signs or exponents).");
  }
  return { amount: token };
}

const isResult = (v: { amount: string } | LifecycleParseResult): v is LifecycleParseResult => "ok" in v;

/** Minutes until the start from "in 15 minutes", "dalam 2 jam", "start in 1 day". Null when no start is given. */
function startMinutes(text: string): number | null {
  const m = START_IN.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!;
  if (/^(h|hrs?|hours?|jam)$/.test(unit)) return n * 60;
  if (/^(d|days?|hari)$/.test(unit)) return n * 24 * 60;
  return n;
}

function parseCreate(text: string): LifecycleParseResult {
  const mode = MODES.find(([re]) => re.test(text))?.[1];
  if (!mode) return clarify("Which scoring mode: price gain, market cap growth, volume ratio or lowest drawdown?");
  const minutes = startMinutes(text);
  if (minutes === null) return clarify("When should it start? For example: in 15 minutes (1 minute to 7 days). Communities join before the start.");
  return validateLifecycleIntent({ kind: "create_battle", mode, startInMinutes: minutes });
}

function battleOnly(text: string): number | LifecycleParseResult {
  const battle = BATTLE_ID.exec(text)?.[1];
  return battle ? Number(battle) : clarify("Which battle? For example: battle 7.");
}

function parseIds(text: string): { battleId: number; communityNumber: number } | LifecycleParseResult {
  const battle = BATTLE_ID.exec(text)?.[1];
  const community = COMMUNITY_NO.exec(text)?.[1];
  if (!battle) return clarify("Which battle? For example: battle 7.");
  if (!community) return clarify("Which community? For example: community 2 (communities are numbered from 1).");
  return { battleId: Number(battle), communityNumber: Number(community) };
}

export const lifecycleRuleParser: LifecycleIntentParser = {
  name: "rules",
  async parse(prompt) {
    const raw = prompt.trim();
    if (raw === "") return fail("Type what you want to do");
    if (raw.length > MAX_PROMPT_CHARS) return fail(`Prompt is too long (max ${MAX_PROMPT_CHARS} characters)`);
    const text = raw.toLowerCase().replace(/\s+/g, " ");

    // Refund before payout: "claim refund" also matches the payout words.
    if (REFUND.test(text)) {
      const ids = parseIds(text);
      if ("ok" in ids) return ids;
      return validateLifecycleIntent({ kind: "claim_refund", ...ids });
    }
    if (CANCEL.test(text) && BATTLE_ID.test(text)) {
      const battleId = battleOnly(text);
      if (typeof battleId !== "number") return battleId;
      return validateLifecycleIntent({ kind: "cancel_battle", battleId });
    }
    // "join battle 7 with CASHCAT" joins by token; "join battle 7 community 2" stays a position registration.
    if (JOIN.test(text) && BATTLE_ID.test(text) && !COMMUNITY_NO.test(text)) {
      const battleId = battleOnly(text);
      if (typeof battleId !== "number") return battleId;
      const token = JOIN_TOKEN.exec(text)?.[1];
      if (!token) return clarify("Which token do you join with? For example: join battle 7 with CASHCAT.");
      return validateLifecycleIntent({ kind: "join_battle", battleId, tokenRef: token });
    }

    if (PAYOUT.test(text)) {
      const destination = ADDRESS.exec(text)?.[0];
      const backing = /\b(?:backing|token|from|dari)\s+([a-z0-9][a-z0-9._-]*\.[a-z0-9._-]+|[a-z0-9_-]{2,64})\b/.exec(text)?.[1];
      const amount = amountOf(text, PAYOUT);
      if (isResult(amount)) return amount;
      if (!destination) return clarify("Which Robinhood address receives the payout? Give a 0x address.");
      if (!backing) return clarify("Which backing token account does the payout come from? For example: from token.testnet.");
      return validateLifecycleIntent({ kind: "payout", backing, amount: amount.amount, destination });
    }
    if (CREATE.test(text) && BATTLE_WORD.test(text) && !BATTLE_ID.test(text)) return parseCreate(text);
    if (REGISTER.test(text)) {
      const ids = parseIds(text);
      if ("ok" in ids) return ids;
      return validateLifecycleIntent({ kind: "register_position", ...ids });
    }
    if (DEPOSIT.test(text)) {
      const ids = parseIds(text);
      if ("ok" in ids) return ids;
      const amount = amountOf(text, DEPOSIT);
      if (isResult(amount)) return amount;
      return validateLifecycleIntent({ kind: "deposit", ...ids, amount: amount.amount });
    }
    if (CREATE.test(text) && BATTLE_WORD.test(text)) return parseCreate(text);
    return clarify("I can create a battle, join one with a token, deposit, cancel, claim a refund or request a payout. Which one?");
  },
};
