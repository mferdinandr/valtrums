"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { TokenIcon } from "@/components/token-icon";
import "@/components/winner-celebration.css";

const COLORS = ["#ffd23f", "#ff5d8f", "#3ddc97", "#4cc9f0", "#b388ff", "#ff9f1c"];
const PIECES = Array.from({ length: 48 }, (_, i) => ({
  left: (i * 37) % 100,
  delay: ((i * 53) % 100) / 100,
  duration: 2.4 + ((i * 29) % 16) / 10,
  drift: ((i * 17) % 21) - 10,
  color: COLORS[i % COLORS.length]!,
}));

/** A one-time celebratory popup shown when the battle is decided; dismissible with the button or Escape. */
export function WinnerCelebration({
  battleId,
  winnerName,
  winnerSymbol,
}: {
  battleId: string;
  winnerName: string;
  winnerSymbol?: string;
}) {
  const [open, setOpen] = useState(true);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="winner-overlay" onClick={() => setOpen(false)}>
      <div className="winner-confetti" aria-hidden="true">
        {PIECES.map((p, i) => (
          <span
            key={i}
            style={{
              left: `${p.left}%`,
              background: p.color,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.duration}s`,
              "--drift": `${p.drift}vw`,
            } as CSSProperties}
          />
        ))}
      </div>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="winner-title"
        className="winner-card"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="eyebrow text-neon-green">BATTLE #{battleId} · FINISHED</p>
        <h2 id="winner-title">We have a winner!</h2>
        {winnerSymbol && <TokenIcon symbol={winnerSymbol} size={88} />}
        <strong className="winner-name">{winnerName}</strong>
        <p className="text-sm text-mute">takes the arena. Congratulations to the whole crew!</p>
        <Button ref={close} variant="cyan" onClick={() => setOpen(false)}>
          See the results
        </Button>
      </div>
    </div>
  );
}
