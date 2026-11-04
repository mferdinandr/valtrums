import { formatUnits, formatUsdc, toBigInt } from "../amounts";
import type { BattleView, SettlementStep, TokenMeta } from "./types";

/** The plan starts with one Dump step and grows to Dump, Buy, Burn, Return once the dump is reported. */
export const FULL_PLAN_LENGTH = 4;

export const STEP_LABEL: Record<SettlementStep["kind"], string> = {
  Dump: "Sell loser vault",
  Buy: "Buy winner coin",
  Burn: "Burn",
  Return: "Protocol fee",
};

export interface PlanRow {
  index: number;
  kind: SettlementStep["kind"];
  /** 1-based position, as shown to the user. */
  number: number;
  label: string;
  /** Planned amount with its unit, e.g. "200,000,000 WOJAK" or "$7,920". */
  amount: string;
  /** Realized amount with its unit once reported. */
  realized: string | null;
  done: boolean;
}

export interface PlanView {
  rows: PlanRow[];
  doneCount: number;
  /** True while only the dump step exists and the other three are not yet scheduled. */
  awaitingDump: boolean;
  summary: string;
}

/**
 * Turns 1 to 4 plan steps into display rows. Dump amounts are in the loser coin; Buy, Burn and Return are
 * USDC amounts; the realized value of a Buy is winner coin and of a Burn is winner coin burned.
 */
export function describePlan(
  steps: SettlementStep[],
  battle: Pick<BattleView, "winner">,
  metaA: TokenMeta,
  metaB: TokenMeta,
): PlanView {
  const sorted = [...steps].sort((x, y) => x.index - y.index);
  const loser = battle.winner === "A" ? metaB : battle.winner === "B" ? metaA : null;
  const winner = battle.winner === "A" ? metaA : battle.winner === "B" ? metaB : null;
  const coin = (v: string, m: TokenMeta | null) =>
    m ? `${formatUnits(toBigInt(v), m.decimals, 2)} ${m.symbol}` : `${v} (coin units)`;

  const rows = sorted.map<PlanRow>((s) => {
    let amount: string;
    let realized: string | null = null;
    switch (s.kind) {
      case "Dump":
        amount = coin(s.amount, loser);
        realized = s.realized === null ? null : formatUsdc(toBigInt(s.realized));
        break;
      case "Buy":
        amount = formatUsdc(toBigInt(s.amount));
        realized = s.realized === null ? null : coin(s.realized, winner);
        break;
      case "Burn":
        amount = formatUsdc(toBigInt(s.amount));
        realized = s.realized === null ? null : `${coin(s.realized, winner)} burned`;
        break;
      default:
        amount = formatUsdc(toBigInt(s.amount));
        realized = s.realized === null ? null : formatUsdc(toBigInt(s.realized));
    }
    return {
      index: s.index,
      kind: s.kind,
      number: s.index + 1,
      label: STEP_LABEL[s.kind],
      amount,
      realized,
      done: s.done,
    };
  });

  const doneCount = rows.filter((r) => r.done).length;
  const awaitingDump = rows.length > 0 && rows.length < FULL_PLAN_LENGTH && rows.every((r) => r.kind === "Dump");
  const summary = awaitingDump
    ? doneCount === 0
      ? "Selling the loser vault. The buy, burn and fee steps are added once the sale is reported."
      : "Sale reported. Waiting for the remaining steps to be added."
    : `${doneCount} of ${rows.length} steps done.`;
  return { rows, doneCount, awaitingDump, summary };
}
