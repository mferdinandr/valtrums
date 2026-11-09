import { FIXTURE_LABEL, assertFixtureAllowed } from "./label.js";
import { listenFixture } from "./server.js";

/** `pnpm -C agent intents:fixture`: serves the local 1Click fixture. Testnet configuration only. */
async function main(): Promise<void> {
  const network = process.env.NEAR_NETWORK?.trim() || "testnet";
  assertFixtureAllowed(network);
  const port = Number(process.env.INTENTS_FIXTURE_PORT ?? "8791");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("INTENTS_FIXTURE_PORT must be a port number");
  await listenFixture({ network, port });
  console.log(`${FIXTURE_LABEL}\nlistening on http://127.0.0.1:${port} (set ONECLICK_API_URL to this address)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
