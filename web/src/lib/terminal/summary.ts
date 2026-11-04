// Human-readable confirmation summary, derived only from the validated plan.

import { formatUnits, formatUsdc } from "../amounts";
import type { DepositPlan } from "./plan";

export interface SummaryLine {
  label: string;
  value: string;
}

export interface Summary {
  title: string;
  lines: SummaryLine[];
  notes: string[];
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function buildSummary(plan: DepositPlan): Summary {
  const bridged = plan.bridgeLegs.reduce((a, l) => a + l.amount, 0n);
  const split = [
    `${formatUsdc(plan.creditUnits, 6)} credit`,
    `${formatUsdc(plan.nearWalletUnits, 6)} NEAR wallet`,
    ...plan.bridgeLegs.map((l) => `${formatUsdc(l.amount, 6)} from ${capitalize(l.chain)}`),
  ].join(" + ");
  const out = (n: bigint) => `${formatUnits(n, plan.tokenDecimals, 4)} ${plan.tokenSymbol}`;

  const lines: SummaryLine[] = [
    { label: "Battle", value: `${plan.battleLabel} (deposit phase)` },
    { label: "Side", value: `Tribe ${plan.side}: $${plan.tokenSymbol}` },
    { label: "Total", value: formatUsdc(plan.totalUnits, 6) },
    { label: "Funding", value: split },
    { label: "Sent from wallet", value: `${formatUsdc(plan.walletUnits, 6)} via ft_transfer_call` },
    { label: "Expected out", value: out(plan.expectedOut) },
    { label: "Minimum out", value: `${out(plan.minOut)} (slippage ${(plan.slippageBps / 100).toFixed(2)}%)` },
    {
      label: "Fees",
      value:
        bridged > 0n
          ? "No deposit fee. Bridge fee is quoted in the next step. NEAR gas applies."
          : "No deposit fee. NEAR gas applies. Settlement takes a share of profit only.",
    },
  ];
  return { title: `Deposit into battle ${plan.battleLabel}`, lines, notes: plan.notes };
}

export function summaryText(s: Summary): string {
  return [s.title, ...s.lines.map((l) => `${l.label}: ${l.value}`), ...s.notes.map((n) => `Note: ${n}`)].join("\n");
}
