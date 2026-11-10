/**
 * The one-line summary above the community picker. `available` is the number of registered tokens, or null when it
 * is not known (the registry list was cut off or has not loaded). The contract limit (`max`) is only mentioned
 * when the number of available tokens is unknown, so the page never suggests more choices than exist.
 */
export function pickerSummary(chosen: number, available: number | null, min: number, max: number): string {
  const parts = [`${chosen} chosen`];
  if (available !== null) parts.push(`${available} available`);
  else parts.push(`up to ${max} allowed`);
  parts.push(`at least ${min} needed`);
  return parts.join(" · ");
}

/** The most communities that can be chosen: the contract limit, or fewer when fewer tokens are registered. */
export function pickerCapacity(available: number | null, max: number): number {
  return available === null ? max : Math.min(max, available);
}
