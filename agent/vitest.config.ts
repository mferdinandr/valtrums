import { existsSync } from "node:fs";
import { configDefaults, defineConfig } from "vitest/config";

// These tests read recorded testnet files from docs/evidence, which is kept out of git.
// On a checkout without that folder they are skipped instead of failing.
const needsEvidence = [
  "test/faucet/funding-plan.test.ts",
  "test/intents-fixture/golden.test.ts",
  "test/intents-fixture/server.test.ts",
  "test/intents-fixture/solver.test.ts",
  "test/intents-fixture/trace.test.ts",
  "test/mcp/application-labels.test.ts",
  "test/token-labels.test.ts",
];
const haveEvidence = existsSync(new URL("../docs/evidence", import.meta.url));

export default defineConfig({
  test: {
    exclude: haveEvidence ? configDefaults.exclude : [...configDefaults.exclude, ...needsEvidence],
  },
});
