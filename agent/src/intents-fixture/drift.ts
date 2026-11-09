/**
 * Drift detection between the fixture and recorded real 1Click responses. A fixture value drifts
 * when a recorded field is missing, has another JSON type, or has another value format. Optional
 * fields the recording lists as `null` count as absent. Extra fixture fields are not drift here;
 * the tests list the only allowed extra key explicitly.
 */

export function formatOf(value: unknown): string {
  if (typeof value !== "string") return typeof value;
  if (/^[0-9]+$/.test(value)) return "digits";
  if (/^[0-9]+\.[0-9]+$/.test(value)) return "decimal";
  if (/^nep141:[a-z0-9._-]+$/.test(value)) return "nep141-asset-id";
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return "evm-address";
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(value)) return "iso-time";
  return "text";
}

/** Problems of `actual` relative to `recorded`; empty means no drift. */
export function driftProblems(recorded: Record<string, unknown>, actual: Record<string, unknown>, path = ""): string[] {
  const problems: string[] = [];
  for (const [key, want] of Object.entries(recorded)) {
    const at = `${path}${key}`;
    const got = actual[key];
    if (want === null) {
      if (got !== undefined && got !== null) problems.push(`${at}: recorded as null/absent, fixture has a value`);
      continue;
    }
    if (got === undefined || got === null) {
      problems.push(`${at}: missing in fixture`);
      continue;
    }
    if (typeof want === "object" && !Array.isArray(want)) {
      if (typeof got !== "object" || Array.isArray(got)) problems.push(`${at}: type object expected`);
      else problems.push(...driftProblems(want as Record<string, unknown>, got as Record<string, unknown>, `${at}.`));
      continue;
    }
    if (typeof want !== typeof got) {
      problems.push(`${at}: type ${typeof want} expected, got ${typeof got}`);
      continue;
    }
    if (formatOf(want) !== formatOf(got)) problems.push(`${at}: format ${formatOf(want)} expected, got ${formatOf(got)}`);
  }
  return problems;
}
