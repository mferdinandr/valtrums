/** The battle-list navigation entry is active on the list and on a lifecycle battle detail, not on creation. */
export function arenaNavigationActive(path: string) {
  return path === "/arena" || /^\/arena\/[1-9][0-9]*$/.test(path);
}
