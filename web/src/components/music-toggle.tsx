"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import {
  MUSIC_FADE_MS,
  MUSIC_PREF_KEY,
  MUSIC_SRC,
  MUSIC_VOLUME,
  fadeVolume,
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

/**
 * Looping background music with a navbar toggle. It lives in the root layout,
 * so it keeps playing across route changes. Browsers only allow sound after a
 * user gesture, so playback starts on the first click, tap or key press.
 */
export function MusicToggle() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const fadeFrame = useRef<number | null>(null);
  const [pref, setPref] = useState<MusicPref>("on");
  const [available, setAvailable] = useState(true);
  const [ready, setReady] = useState(false);

  const fadeTo = useCallback((target: number, then?: () => void) => {
    const el = audio.current;
    if (!el) return;
    if (fadeFrame.current !== null) cancelAnimationFrame(fadeFrame.current);
    const from = el.volume;
    const start = performance.now();
    const step = (now: number) => {
      el.volume = fadeVolume(from, target, now - start, MUSIC_FADE_MS);
      if (now - start < MUSIC_FADE_MS) fadeFrame.current = requestAnimationFrame(step);
      else {
        fadeFrame.current = null;
        then?.();
      }
    };
    fadeFrame.current = requestAnimationFrame(step);
  }, []);

  const play = useCallback(() => {
    const el = audio.current;
    if (!el) return;
    el.play()
      .then(() => fadeTo(MUSIC_VOLUME))
      .catch(() => {
        // Autoplay blocked or decoding failed; the next gesture tries again.
      });
  }, [fadeTo]);

  useEffect(() => {
    const el = new Audio(MUSIC_SRC);
    el.loop = true;
    el.preload = "auto";
    el.volume = 0;
    const onError = () => setAvailable(false);
    el.addEventListener("error", onError);
    audio.current = el;
    const initial = readPref();
    setPref(initial);
    setReady(true);

    const onGesture = () => {
      if (readPref() === "on" && el.paused) play();
    };
    const onVisibility = () => {
      if (document.hidden) el.pause();
      else if (readPref() === "on" && el.currentTime > 0) play();
    };
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      document.removeEventListener("visibilitychange", onVisibility);
      el.removeEventListener("error", onError);
      if (fadeFrame.current !== null) cancelAnimationFrame(fadeFrame.current);
      el.pause();
      audio.current = null;
    };
  }, [play]);

  const toggle = () => {
    const next: MusicPref = pref === "on" ? "off" : "on";
    setPref(next);
    writePref(next);
    if (next === "on") play();
    else fadeTo(0, () => audio.current?.pause());
  };

  if (!available || !ready) return null;
  const on = pref === "on";
  return (
    <button
      type="button"
      onClick={toggle}
      // The window listener would otherwise start the music before toggle() runs.
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
