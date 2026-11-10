"use client";

import { useState } from "react";
import { X } from "lucide-react";
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
}: {
  namespace: Namespace;
  /** `chainId:token` keys already chosen. */
  chosen: ReadonlySet<string>;
  full: boolean;
  onPick: (a: RegistryAsset) => void;
}) {
  const [q, setQ] = useState("");
  const { result, loading, error } = useApplicationSearch<ApplicationPage<RegistryAsset>>(namespace, "assets", { q, limit: 24 });
  const items = result?.data.items ?? [];
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
      <ul className="token-grid">
        {items.map((a) => {
          const symbol = assetSymbol(a);
          const taken = chosen.has(`${a.chainId}:${a.token.toLowerCase()}`);
          const title = [a.label?.name, `${a.chainId}:${a.token}`].filter(Boolean).join(" · ");
          return (
            <li key={a.assetKey}>
              <button
                type="button"
                className="token-card"
                style={{ ["--token-accent" as string]: accentFor(symbol) }}
                disabled={taken || full}
                aria-label={taken ? `${symbol} already chosen` : `Add ${symbol}`}
                title={title}
                onClick={() => onPick(a)}
              >
                <TokenIcon symbol={symbol} size={44} />
                <strong>{symbol}</strong>
                <span>{shortAccount(a.token)}</span>
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
