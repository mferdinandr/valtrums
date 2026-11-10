import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attestArgsFromVerifyOutput, attestCommand, buildPlan, loadFundingFacts } from "./funding-plan.js";

/**
 * `node dist/faucet/funding-plan-cli.js plan --faucet <account> --battle <id> --depositor <0x> [--tokens 1000000] [--symbols CASHCAT,WALLET]`
 * `node dist/faucet/funding-plan-cli.js attest --file <verify-output.json>`
 *
 * Prints text only. It sends nothing, reads no key and makes no network call.
 */
const arg = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

export function run(argv: string[], readFile: (p: string) => string = (p) => readFileSync(p, "utf8")): string {
  const dir = arg(argv, "evidence-dir") ?? join(process.cwd(), "..", "docs", "evidence");
  const facts = loadFundingFacts((name) => JSON.parse(readFile(join(dir, name))));
  if (argv[0] === "attest") {
    const file = arg(argv, "file");
    if (!file) throw new Error("pass --file <verify-output.json>");
    return `${attestCommand(facts, attestArgsFromVerifyOutput(JSON.parse(readFile(file))))}\n`;
  }
  if (argv[0] !== "plan") throw new Error("usage: plan --faucet <account> --battle <id> --depositor <0x> | attest --file <json>");
  const faucet = arg(argv, "faucet");
  const battleId = arg(argv, "battle");
  const depositor = arg(argv, "depositor");
  if (!faucet || !battleId || !depositor) throw new Error("plan needs --faucet, --battle and --depositor");
  const symbols = arg(argv, "symbols")?.split(",").map((s) => s.trim()).filter(Boolean);
  const steps = buildPlan(facts, { faucet, battleId, depositor, tokens: Number(arg(argv, "tokens") ?? "1000000"), ...(arg(argv, "refund") ? { refund: arg(argv, "refund")! } : {}), ...(symbols ? { symbols } : {}) });
  const lines = ["# Faucet funding plan (NOTHING HAS BEEN SENT)", "", "Run each mutating step yourself, one at a time, after checking the command. Placeholders in <ANGLE BRACKETS> come from earlier steps.", ""];
  steps.forEach((s, i) => {
    lines.push(`${i + 1}. [${s.mutating ? "SENDS A TRANSACTION" : "read-only"}] ${s.title}`, `   chain: ${s.chain}   signer: ${s.signer}`, `   ${s.command}`);
    if (s.note) lines.push(`   note: ${s.note}`);
    lines.push("");
  });
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
