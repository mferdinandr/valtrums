/**
 * Pages that exist in application read mode: the battle list, the lifecycle detail and the review-only
 * creation page. Every other page (the legacy A/B flow, the terminal, the portfolio) is unavailable there and
 * is never reached by a fallback.
 */
export function isApplicationRoute(path: string | null): boolean {
  if (!path) return false;
  return (
    path === "/arena" ||
    path === "/arena/new" ||
    /^\/arena\/[1-9][0-9]{0,19}$/.test(path)
  );
}

export const createBattlePath = (application: boolean) =>
  application ? "/arena/new" : "/battles/new";
export function arenaNavigationActive(path: string) {
  return (
    path === "/arena" ||
    /^\/arena\/[1-9][0-9]*$/.test(path) ||
    (path.startsWith("/battles/") && path !== "/battles/new")
  );
}
