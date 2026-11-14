"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import {
  MUSIC_FADE_SECONDS,
  MUSIC_PREF_KEY,
  MUSIC_SRC,
  MUSIC_VOLUME,
  loopEnd,
  parseMusicPref,
  type MusicPref,
} from "@/lib/background-music";

function readPref(): MusicPref {
  try {
    return parseMusicPref(window.localStorage.getItem(MUSIC_PREF_KEY));
  } catch {
    return "on";
  }
}

function writePref(pref: MusicPref) {
  try {
    window.localStorage.setItem(MUSIC_PREF_KEY, pref);
  } catch {
    // Storage can be blocked (private mode); the toggle still works for this visit.
  }
}

type Player = { ctx: AudioContext; gain: GainNode };

/**
 * Looping background music with a navbar toggle. It lives in the root layout,
 * so it keeps playing across route changes. Browsers only allow sound after a
 * user gesture, so playback starts on the first click, tap or key press.
 * Web Audio loops the decoded buffer on the exact musical cycle (no MP3 gap).
 */
export function MusicToggle() {
  const player = useRef<Player | null>(null);
  const starting = useRef<Promise<Player | null> | null>(null);
  const [pref, setPref] = useState<MusicPref | null>(null);
  const [available, setAvailable] = useState(true);

  const ramp = useCallback((p: Player, to: number) => {
    const now = p.ctx.currentTime;
    p.gain.gain.cancelScheduledValues(now);
    p.gain.gain.setValueAtTime(p.gain.gain.value, now);
    p.gain.gain.linearRampToValueAtTime(to, now + MUSIC_FADE_SECONDS);
  }, []);

  /** Create the context and start the loop once; later calls reuse it. */
  const ensurePlayer = useCallback((): Promise<Player | null> => {
    if (player.current) return Promise.resolve(player.current);
    if (starting.current) return starting.current;
    starting.current = (async () => {
      try {
        const ctx = new AudioContext();
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.connect(ctx.destination);
        const res = await fetch(MUSIC_SRC);
        if (!res.ok) throw new Error(`music ${res.status}`);
        const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.loopStart = 0;
        source.loopEnd = loopEnd(buffer.duration);
        source.connect(gain);
        source.start();
        player.current = { ctx, gain };
        return player.current;
      } catch {
        setAvailable(false);
        return null;
      } finally {
        starting.current = null;
      }
    })();
    return starting.current;
  }, []);

  const play = useCallback(async () => {
    const p = await ensurePlayer();
    if (!p) return;
    await p.ctx.resume().catch(() => undefined);
    ramp(p, MUSIC_VOLUME);
  }, [ensurePlayer, ramp]);

  const stop = useCallback(() => {
    const p = player.current;
    if (!p) return;
    ramp(p, 0);
    window.setTimeout(() => {
      if (readPref() === "off") void p.ctx.suspend();
    }, MUSIC_FADE_SECONDS * 1000 + 50);
  }, [ramp]);

  useEffect(() => {
    setPref(readPref());
    const onGesture = () => {
      if (readPref() === "on" && player.current?.ctx.state !== "running") void play();
    };
    const onVisibility = () => {
      const p = player.current;
      if (!p) return;
      if (document.hidden) void p.ctx.suspend();
      else if (readPref() === "on") void play();
    };
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      document.removeEventListener("visibilitychange", onVisibility);
      void player.current?.ctx.close();
      player.current = null;
    };
  }, [play]);

  const toggle = () => {
    const next: MusicPref = pref === "off" ? "on" : "off";
    setPref(next);
    writePref(next);
    if (next === "on") void play();
    else stop();
  };

  if (!available || pref === null) return null;
  const on = pref === "on";
  return (
    <button
      type="button"
      onClick={toggle}
      // Keep the window gesture listener from starting music before toggle() runs.
      onPointerDown={(e) => e.stopPropagation()}
      aria-pressed={on}
      aria-label={on ? "Mute background music" : "Play background music"}
      title={on ? "Mute music" : "Play music"}
      className="flex size-11 items-center justify-center rounded-full border border-edge bg-panel text-mute transition-colors hover:text-ink"
    >
      {on ? <Volume2 size={18} /> : <VolumeX size={18} />}
    </button>
  );
}
