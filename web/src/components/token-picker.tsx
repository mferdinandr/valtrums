"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { Check, X } from "lucide-react";
import { TokenIcon } from "@/components/token-icon";
import { Input, Label } from "@/components/ui/input";
import { useApplicationSearch } from "@/hooks/use-application-search";
import type { ApplicationPage, Namespace } from "@/lib/arena-read/application";
import { shortAccount } from "@/lib/arena-read/lifecycle-presentation";
import { accentFor, displaySymbol } from "@/lib/arena-read/token-style";

export interface RegistryAsset {
  chainId: string;
  token: string;
  referenceChainId: string;
  referenceToken: string;
  assetKey: string;
  registryVersion: string;
  /** Curated display names (token and mainnet reference). Never identity or eligibility. */
  label?: { symbol: string; name: string; kind: "testnet-mock" | "mainnet-reference" } | null;
  referenceLabel?: { symbol: string; name: string; kind: "testnet-mock" | "mainnet-reference" } | null;
}

/** The name shown for a registry asset: its label without the testnet prefix, or the short address. */
export const assetSymbol = (a: RegistryAsset): string =>
  displaySymbol(a.label ?? a.referenceLabel ?? null, shortAccount(a.token));

/** A chip for one chosen community, with a button to remove it. */
export function TokenChip({ symbol, onRemove }: { symbol: string; onRemove: () => void }) {
  return (
    <span className="token-chip" style={{ borderColor: accentFor(symbol) }}>
      <TokenIcon symbol={symbol} size={26} />
      <strong>{symbol}</strong>
      <button type="button" onClick={onRemove} aria-label={`Remove ${symbol}`}>
        <X size={14} aria-hidden="true" />
      </button>
    </span>
  );
}

/**
 * Backend-searched pick from the protocol's registry, shown as a grid of tokens. Identity comes from the registry
 * entry, never from typing. A token that is already chosen is dimmed and cannot be chosen twice.
 */
export function TokenPicker({
  namespace,
  chosen,
  full,
  onPick,
  onAvailable,
}: {
  namespace: Namespace;
  /** `chainId:token` keys already chosen. */
  chosen: ReadonlySet<string>;
  full: boolean;
  onPick: (a: RegistryAsset) => void;
  /** Reports how many tokens are registered, or null when the list is cut off or not loaded yet. */
  onAvailable?: (count: number | null) => void;
}) {
  const [q, setQ] = useState("");
  const { result, loading, error } = useApplicationSearch<ApplicationPage<RegistryAsset>>(namespace, "assets", { q, limit: 24 });
  const items = result?.data.items ?? [];
  // The total is only known from an unfiltered, complete list; a search narrows the list and must not change it.
  useEffect(() => {
    if (q === "" && result && !loading) onAvailable?.(result.data.nextCursor ? null : result.data.items.length);
  }, [q, result, loading, onAvailable]);
  const grid = useRef<HTMLUListElement>(null);
  const seen = useRef<Set<string>>(new Set());
  // Cards slide in once, and a card that has just been chosen pops so the choice is easy to spot.
  useEffect(() => {
    const el = grid.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const fresh = Array.from(el.querySelectorAll<HTMLElement>("[data-asset]")).filter((c) => !seen.current.has(c.dataset.asset ?? ""));
    fresh.forEach((c) => seen.current.add(c.dataset.asset ?? ""));
    if (fresh.length === 0) return;
    const ctx = gsap.context(() => {
      gsap.from(fresh, { autoAlpha: 0, y: 14, duration: 0.35, stagger: 0.04, ease: "power2.out", clearProps: "opacity,visibility,transform" });
    }, el);
    return () => ctx.revert();
  }, [items]);
  const picked = Array.from(chosen).join("|");
  const lastPicked = useRef(picked);
  useEffect(() => {
    const el = grid.current;
    const added = picked.split("|").filter((k) => k && !lastPicked.current.split("|").includes(k));
    lastPicked.current = picked;
    if (!el || added.length === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const cards = Array.from(el.querySelectorAll<HTMLElement>("[data-selected='true']"));
    const ctx = gsap.context(() => {
      gsap.fromTo(cards, { scale: 0.92 }, { scale: 1, duration: 0.5, ease: "back.out(2.2)", clearProps: "transform" });
    }, el);
    return () => ctx.revert();
  }, [picked]);
  return (
    <div className="space-y-3">
      <Label>
        Find a community token
        <Input
          value={q}
          maxLength={64}
          placeholder="Search a token name (CASHCAT) or address"
          onChange={(e) => setQ(e.target.value)}
        />
      </Label>
      {loading && (
        <p role="status" className="text-xs text-mute">
          Searching…
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-neon-red">
          Asset search unavailable: {error}
        </p>
      )}
      {result && !loading && items.length === 0 && (
        <p className="text-xs text-mute">No registered asset matches. Registry membership is required.</p>
      )}
      <ul ref={grid} className="token-grid">
        {items.map((a) => {
          const symbol = assetSymbol(a);
          const taken = chosen.has(`${a.chainId}:${a.token.toLowerCase()}`);
          const title = [a.label?.name, `${a.chainId}:${a.token}`].filter(Boolean).join(" · ");
          return (
            <li key={a.assetKey} data-asset={a.assetKey}>
              <button
                type="button"
                className="token-card"
                data-selected={taken}
                style={{ ["--token-accent" as string]: accentFor(symbol) }}
                disabled={taken || full}
                aria-label={taken ? `${symbol} already chosen` : `Add ${symbol}`}
                title={title}
                onClick={() => onPick(a)}
              >
                {taken && (
                  <span className="token-card-check" aria-hidden="true">
                    <Check size={14} strokeWidth={3} />
                  </span>
                )}
                <TokenIcon symbol={symbol} size={44} />
                <strong>{symbol}</strong>
                {taken && <span className="token-card-state">Selected</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {result && (
        <p className="text-xs text-mute">
          Testnet tokens. Logos come from each token&apos;s public listing and are not a verification. Registry
          membership is not audit, backing or deposit eligibility.
        </p>
      )}
    </div>
  );
}
