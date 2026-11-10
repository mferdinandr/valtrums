/**
 * Pages that exist in application read mode: the landing page (static content, no battle data), the battle
 * list, the lifecycle detail, the review-only creation page and the lifecycle intent terminal. The legacy A/B
 * flow and the portfolio are unavailable there and are never reached by a fallback.
 */
export function isApplicationRoute(path: string | null): boolean {
  if (!path) return false;
  return (
    path === "/" ||
    path === "/arena" ||
    path === "/arena/new" ||
    path === "/terminal" ||
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
