"use client";

import { useState } from "react";
import { logoSrc } from "@/lib/token-logos";
import { accentFor, monogram } from "@/lib/arena-read/token-style";

/**
 * The token's logo in a colored frame. When the logo is unknown or fails to load, a monogram on the same color
 * is shown, so a token is never left without an icon. The image is decorative: the name is always written next to it.
 */
export function TokenIcon({ symbol, size = 40 }: { symbol: string; size?: number }) {
  const src = logoSrc(symbol);
  const [failed, setFailed] = useState(false);
  const accent = accentFor(symbol);
  return (
    <span
      className="token-icon"
      aria-hidden="true"
      style={{ width: size, height: size, borderColor: accent, background: `${accent}22`, color: accent, fontSize: Math.round(size * 0.36) }}
    >
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        monogram(symbol)
      )}
    </span>
  );
}
