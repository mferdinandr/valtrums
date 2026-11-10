/**
 * Every surface of the fixture (logs, HTTP headers, status and quote bodies, action previews, UI)
 * carries this label. The fixture is not NEAR Intents and proves no Intents integration (D29).
 */
export const FIXTURE_ROUTE = "intents-fixture";
export const FIXTURE_LABEL = "FIXTURE: local 1Click API fixture on testnet. Not NEAR Intents; no real solver, no mainnet funds.";
export const FIXTURE_HEADER = "x-valtrum-fixture";

export class FixtureConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureConfigError";
  }
}

/** The fixture only exists on testnet. Any other configuration refuses to start or to accept the route. */
export function assertFixtureAllowed(network: string | undefined): void {
  if (network !== "testnet" && network !== "near-testnet") {
    throw new FixtureConfigError(`the ${FIXTURE_ROUTE} route is available only when the configuration is testnet (got "${network ?? "unset"}")`);
  }
}
