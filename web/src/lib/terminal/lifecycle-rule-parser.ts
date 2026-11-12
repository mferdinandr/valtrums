// Deterministic parser for lifecycle prompts in English and Bahasa Indonesia. No network, no model. Whatever it
// returns still goes through `validateLifecycleIntent`, so it can never produce something the boundary would refuse.
// Amounts are plain token amounts ("100", "0.5"): the conversion to base units is done once, by code, in the validator.

import {
  MAX_PROMPT_CHARS,
  validateLifecycleIntent,
  type LifecycleIntentParser,
  type LifecycleParseResult,
} from "./lifecycle-intent";

const clarify = (error: string): LifecycleParseResult => ({ ok: false, error, clarify: true });
const fail = (error: string): LifecycleParseResult => ({ ok: false, error });

const PAYOUT = /\b(payout|pay out|withdraw|withdrawal|claim|tarik|penarikan|cairkan|klaim)\b/;
/** The prize itself, to the NEAR wallet: "claim my winnings", "klaim hadiah". A 0x address or "payout" keeps the Robinhood payout. */
const CLAIM = /\b(claim|klaim|withdraw|tarik|cairkan|ambil)\b/;
const PRIZE = /\b(winnings?|prizes?|rewards?|hadiah|kemenangan|menang)\b/;
const ROBINHOOD_PAYOUT = /\b(payout|pay out|robinhood|penarikan)\b/;
const DAO_VOTE = /\b(vote|voting|vote-?kan|suara|dao)\b/;
const BURN = /\b(burn|bakar|burned|dibakar)\b/;
const KEEP = /\b(return|returned|kembalikan|dikembalikan|keep|simpan)\b/;
const SAME_BATTLE = /\b(tersebut|itu|tadi|same|that|this)\b/;
const PERCENT = /(\d{1,3})\s*%/;
const CREATE = /\b(create|make|new|start|launch|buat|bikin|bikinkan|buatkan|mulai)\b/;
const BATTLE_WORD = /\b(battle|battles|arena|arenas|duel|pertarungan)\b/;
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
/** "the open arena", "arena yang lagi open", "an open battle": no battle was named, any open one will do. */
const OPEN_REF = /\b(open|opened|terbuka|buka|yang open|lagi open|available|tersedia|latest|terbaru)\b/;
/** A question about the arenas: "which arenas are open?", "arena apa yang open", "show open battles". */
const ASK_BATTLES = /\b(which|what|show|list|see|display|any|lihat|tampilkan|daftar|apa saja|apa aja|arena apa|battle apa|ada)\b/;
const MY_POSITIONS = /\b(my positions?|my deposits?|my holdings?|posisi saya|posisiku|posisi ku|deposit saya|setoran saya)\b/;

const MODES: Array<[RegExp, string]> = [
  [/(price\s*(?:%\s*)?gain|price climb|harga naik|kenaikan harga|price)/, "PriceGain"],
  [/(market\s*-?cap(?:italization)?\s*(?:%\s*)?(?:growth|gain)?|mcap|kapitalisasi pasar|pertumbuhan komunitas)/, "MarketCapGrowth"],
  [/(volume\s*(?:-?to-?\s*market\s*-?cap)?\s*(?:ratio)?|rasio volume|trading energy)/, "VolumeRatio"],
  [/(lowest\s*(?:%\s*)?drawdown|drawdown|penurunan terendah|steadiest)/, "LowestDrawdown"],
];

const STOP_WORDS = /^(ke|to|into|di|in|on|for|untuk|battle|arena|komunitas|community|crew|the|a|an|yang|lagi|open|terbuka|token|tokens|koin|coin|of|sebesar)$/;

/**
 * "deposit 100 CASHCAT to ...", "setor 0.5 ke ...": the amount (digits with an optional dot) and, when it follows the
 * amount, the token to back. The amount stays text here; the validator converts it to base units.
 */
function depositParts(text: string): { amountTokens: string; tokenRef: string | null } | LifecycleParseResult {
  const m = /(?:\bdeposit(?:kan)?|\bsetor(?:kan)?|\bmenyetor|\btop ?up)\s+(?:sebesar\s+|of\s+|amount\s+|jumlah\s+)?(\S+)(?:\s+(?:token\s+)?(\$?[a-z0-9][a-z0-9._$-]{0,79}))?/.exec(text);
  const amountToken = m?.[1] ?? /(?:sebesar|amount|jumlah)\s+(\S+)/.exec(text)?.[1];
  if (!amountToken || STOP_WORDS.test(amountToken)) return clarify("How much? For example: deposit 100 CASHCAT.");
  const amount = amountToken.replace(/[.,]$/, "");
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    return fail("The amount must be a plain number of tokens such as 100 or 0.5 (no separators, signs or exponents).");
  }
  const word = m?.[2];
  return { amountTokens: amount, tokenRef: word && !STOP_WORDS.test(word.replace(/^\$/, "")) ? word : null };
}

/** The arena part of a prompt: a battle id, or (no id) "an open arena", which the terminal resolves from the list. */
const battleRef = (text: string): { battleId: number } | { battle: "open" } => {
  const id = BATTLE_ID.exec(text)?.[1];
  return id ? { battleId: Number(id) } : { battle: "open" };
};

/** Amounts of the payout request, still base units (payout stays blocked in the UI; it has no friendly path). */
function payoutAmount(text: string): { amount: string } | LifecycleParseResult {
  const token = new RegExp(`${PAYOUT.source}\\s+(?:sebesar\\s+|of\\s+|amount\\s+|jumlah\\s+)?(\\S+)`).exec(text)?.[2] ?? /(?:sebesar|amount|jumlah)\s+(\S+)/.exec(text)?.[1] ?? null;
  if (token === null) return clarify("How much? Give an exact whole number in token base units, for example 250.");
  if (!/^[1-9][0-9]{0,38}$/.test(token)) return fail("The amount must be a positive whole number of base units in plain digits (no decimals, separators, signs or exponents).");
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

/** Refunds act on one known battle and community. */
function refundIds(text: string): { battleId: number; communityNumber: number } | LifecycleParseResult {
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

    // Questions first: they never build a request.
    if (MY_POSITIONS.test(text)) return validateLifecycleIntent({ kind: "show_positions" });
    const isAction = DAO_VOTE.test(text) || DEPOSIT.test(text) || CANCEL.test(text) || REFUND.test(text) || PAYOUT.test(text) || (CREATE.test(text) && !/\b(any|which|what|show|list)\b/.test(text));
    if (!isAction && BATTLE_WORD.test(text) && ASK_BATTLES.test(text) && !BATTLE_ID.test(text)) {
      return validateLifecycleIntent({ kind: "list_battles", status: OPEN_REF.test(text) ? "open" : "all" });
    }

    // The DAO vote on the winners' principal: "vote burn 50% battle 7", "vote return battle 7", "vote bakar battle 7".
    if (DAO_VOTE.test(text) && (BURN.test(text) || KEEP.test(text) || PERCENT.test(text))) {
      // "that battle" (tersebut, itu, same) points at the battle of an earlier request in the same prompt.
      const id = BATTLE_ID.exec(text)?.[1];
      if (!id && !SAME_BATTLE.test(text)) return clarify("Which battle? For example: battle 7.");
      const percent = PERCENT.exec(text)?.[1];
      const burnPercent = percent !== undefined ? Number(percent) : BURN.test(text) && !KEEP.test(text) ? 100 : 0;
      return validateLifecycleIntent({ kind: "dao_vote", ...(id ? { battleId: Number(id) } : { battle: "same" }), burnPercent });
    }
    if (DAO_VOTE.test(text)) return clarify("Burn or return? For example: vote burn 50% on battle 7, or vote return on battle 7.");

    // Refund before payout: "claim refund" also matches the payout words.
    if (REFUND.test(text)) {
      const ids = refundIds(text);
      if ("ok" in ids) return ids;
      return validateLifecycleIntent({ kind: "claim_refund", ...ids });
    }
    if (CANCEL.test(text) && BATTLE_ID.test(text)) {
      const battleId = battleOnly(text);
      if (typeof battleId !== "number") return battleId;
      return validateLifecycleIntent({ kind: "cancel_battle", battleId });
    }
    // "join battle 7 with CASHCAT" / "join the open arena with CASHCAT" joins by token; "join battle 7 community 2" stays a registration.
    if (JOIN.test(text) && (BATTLE_ID.test(text) || OPEN_REF.test(text)) && !COMMUNITY_NO.test(text) && !DEPOSIT.test(text)) {
      const token = JOIN_TOKEN.exec(text)?.[1];
      if (!token) return clarify("Which token do you join with? For example: join battle 7 with CASHCAT.");
      return validateLifecycleIntent({ kind: "join_battle", ...battleRef(text), tokenRef: token });
    }

    // Claiming the prize goes to the NEAR wallet unless a 0x address or a payout word asks for the Robinhood payout.
    if (CLAIM.test(text) && !ADDRESS.test(text) && !ROBINHOOD_PAYOUT.test(text) && (PRIZE.test(text) || !/\d/.test(text))) {
      return validateLifecycleIntent({ kind: "claim_winnings" });
    }
    if (PAYOUT.test(text)) {
      const destination = ADDRESS.exec(text)?.[0];
      const backing = /\b(?:backing|token|from|dari)\s+([a-z0-9][a-z0-9._-]*\.[a-z0-9._-]+|[a-z0-9_-]{2,64})\b/.exec(text)?.[1];
      const amount = payoutAmount(text);
      if (isResult(amount)) return amount;
      if (!destination) return clarify("Which Robinhood address receives the payout? Give a 0x address.");
      if (!backing) return clarify("Which backing token account does the payout come from? For example: from token.testnet.");
      return validateLifecycleIntent({ kind: "payout", backing, amount: amount.amount, destination });
    }
    if (CREATE.test(text) && BATTLE_WORD.test(text) && !BATTLE_ID.test(text)) return parseCreate(text);
    if (REGISTER.test(text) && !DEPOSIT.test(text)) {
      const community = COMMUNITY_NO.exec(text)?.[1];
      if (!community) return clarify("Which community? For example: community 2 (communities are numbered from 1).");
      return validateLifecycleIntent({ kind: "register_position", ...battleRef(text), communityNumber: Number(community) });
    }
    if (DEPOSIT.test(text)) {
      const parts = depositParts(text);
      if ("ok" in parts) return parts;
      const community = COMMUNITY_NO.exec(text)?.[1];
      if (!community && !parts.tokenRef) {
        return clarify("Which community or token do you back? For example: deposit 100 CASHCAT, or deposit 100 to community 2.");
      }
      return validateLifecycleIntent({
        kind: "deposit",
        ...battleRef(text),
        ...(community ? { communityNumber: Number(community) } : { tokenRef: parts.tokenRef }),
        amountTokens: parts.amountTokens,
      });
    }
    if (CREATE.test(text) && BATTLE_WORD.test(text)) return parseCreate(text);
    return clarify("I can create a battle, join one with a token, deposit, cancel, claim a refund, or answer questions like \"which arenas are open?\" and \"my positions\". Which one?");
  },
};
