/** Background music settings shared by the navbar toggle. */

export const MUSIC_SRC = "/audio/bgm.mp3";
export const MUSIC_VOLUME = 0.22;
export const MUSIC_FADE_MS = 900;
export const MUSIC_PREF_KEY = "valtrums:music";

export type MusicPref = "on" | "off";

/** Music is on unless the visitor turned it off before. */
export function parseMusicPref(raw: string | null | undefined): MusicPref {
  return raw === "off" ? "off" : "on";
}

/** Volume at `elapsed` ms of a fade from `from` to `to` (ease in-out, clamped). */
export function fadeVolume(from: number, to: number, elapsed: number, duration = MUSIC_FADE_MS): number {
  if (duration <= 0) return to;
  const t = Math.min(1, Math.max(0, elapsed / duration));
  const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  return Math.min(1, Math.max(0, from + (to - from) * eased));
}
