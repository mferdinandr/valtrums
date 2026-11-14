/**
 * Background music settings shared by the navbar toggle.
 *
 * Track: "Children's March Theme" by Cleyton Kauffman, CC0 (public domain),
 * https://opengameart.org/content/childrens-march-theme. One musical cycle is
 * exactly 64 s, so the decoded buffer loops on that boundary without a gap.
 */

export const MUSIC_SRC = "/audio/bgm.mp3";
export const MUSIC_LOOP_SECONDS = 64;
export const MUSIC_VOLUME = 0.22;
export const MUSIC_FADE_SECONDS = 0.9;
export const MUSIC_PREF_KEY = "valtrums:music";

export type MusicPref = "on" | "off";

/** Music is on unless the visitor turned it off before. */
export function parseMusicPref(raw: string | null | undefined): MusicPref {
  return raw === "off" ? "off" : "on";
}

/** Loop end inside a decoded buffer: the musical cycle, never past the buffer. */
export function loopEnd(bufferSeconds: number, cycleSeconds: number = MUSIC_LOOP_SECONDS): number {
  if (!(bufferSeconds > 0)) return 0;
  return Math.min(bufferSeconds, cycleSeconds);
}
