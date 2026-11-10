/**
 * Pages that exist in application read mode: the landing page (static content, no battle data), the battle
 * list, the lifecycle detail, the review-only creation page, the lifecycle intent terminal and the lifecycle
 * portfolio. The former A/B flow is gone and is never reached by a fallback.
 */
export function isApplicationRoute(path: string | null): boolean {
  if (!path) return false;
  return (
    path === "/" ||
    path === "/arena" ||
    path === "/arena/new" ||
    path === "/terminal" ||
    path === "/portfolio" ||
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
