/**
 * Token logos come from the DexScreener listing of the token each testnet mock stands in for (matched by the
 * mainnet reference address, found 2026-11-11). They are uploaded by whoever lists the token, so an image is
 * recognition only: it is not verification and never implies approval. Browsers never contact the image host;
 * `/api/token-logo/<symbol>` fetches the fixed image id below and serves it with caching.
 */
export const LOGO_IDS: Readonly<Record<string, string>> = {
  cashcat: "Lq7a3pS9Wn8EuGp0",
  wallet: "I2L-IaR50qberU4d",
  good: "WV3AcN3Do_pj4wbf",
  ai: "e3TLmSC86-ocZi56",
  vlad: "gYL4WuZKu56Eb0Cx",
  degen: "EIckJJdtCwN-ynPT",
};

const norm = (symbol: string) => symbol.trim().toLowerCase();

/** Our own URL for a symbol's logo, or null when none is known. */
export function logoSrc(symbol: string): string | null {
  const key = norm(symbol);
  return Object.prototype.hasOwnProperty.call(LOGO_IDS, key) ? `/api/token-logo/${key}` : null;
}

/** The fixed upstream image URL for a known symbol. Only ever built from the table above, never from input. */
export function logoUpstream(symbol: string): string | null {
  const key = norm(symbol);
  if (!Object.prototype.hasOwnProperty.call(LOGO_IDS, key)) return null;
  return `https://cdn.dexscreener.com/cms/images/${LOGO_IDS[key]}?width=128&height=128&quality=90&format=auto`;
}
