/** A moment in the viewer's own time zone, for example "14 Nov 2026, 10:22 AM". `timeZone` is for tests. */
export const localTime = (ms: number, timeZone?: string): string =>
  new Date(ms)
    .toLocaleString("en-GB", {
      day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
      ...(timeZone ? { timeZone } : {}),
    })
    .replace(/\b([ap])m\b/, (m) => m.toUpperCase());
