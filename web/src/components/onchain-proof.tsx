"use client";

import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, Copy, ExternalLink, RefreshCw, Trophy } from "lucide-react";
import { config } from "@/lib/config";
import { formatAmount, loadBattleProof, makeRpc, verifyCommand, type BattleProof } from "@/lib/onchain-proof";

const link = (path: string) => `${config.explorerUrl}${path}`;

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-xs underline underline-offset-4 hover:text-ink">
      {children} <ExternalLink size={12} aria-hidden />
    </a>
  );
}

/** Battle state read live from the arena contract, with the block it was read at. */
export function OnchainProof({ contract, battleId }: { contract: string; battleId: number }) {
  const [proof, setProof] = useState<BattleProof | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProof(await loadBattleProof(makeRpc(config.rpcUrl), contract, battleId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [contract, battleId]);

  useEffect(() => {
    void load();
  }, [load]);

  const command = verifyCommand(contract, battleId, config.network);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; the command stays visible to select by hand.
    }
  };

  return (
    <section aria-label="On-chain proof" className="pixel-frame">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BadgeCheck size={22} className="text-neon-green" aria-hidden />
          <h2 className="text-lg">Verified on-chain</h2>
          <span className="rounded-full border border-edge px-2 py-0.5 text-xs text-mute">NEAR {config.network}</span>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex min-h-11 items-center gap-2 rounded-full border border-edge bg-panel px-4 text-xs text-mute hover:text-ink disabled:opacity-60"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : undefined} aria-hidden /> Re-read from chain
        </button>
      </div>
      <p className="mt-2 text-sm text-mute">
        Read live from the arena contract over NEAR RPC, not from the Valtrums backend. Anyone can check the same values on the explorer or with the command below.
      </p>

      {error && (
        <p role="alert" className="mt-4 text-sm text-neon-red">
          Could not read the contract: {error}
        </p>
      )}
      {!proof && !error && <p className="mt-4 text-sm text-mute">Reading the contract…</p>}

      {proof && (
        <div className="mt-4 space-y-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-mute">Arena contract</dt>
              <dd><Ext href={link(`/address/${proof.contract}`)}>{proof.contract}</Ext></dd>
            </div>
            <div>
              <dt className="text-xs text-mute">Read at block</dt>
              <dd>
                <Ext href={link(`/blocks/${proof.blockHash}`)}>#{proof.blockHeight.toLocaleString("en-US")}</Ext>{" "}
                <span className="font-mono text-xs text-mute">{proof.blockHash.slice(0, 10)}…</span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-mute">Battle</dt>
              <dd className="font-mono text-xs">
                #{proof.battleId} · {proof.mode} · {proof.cancelled ? "cancelled" : proof.locked ? "locked" : "open"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-mute">Creator</dt>
              <dd><Ext href={link(`/address/${proof.creator}`)}>{proof.creator}</Ext></dd>
            </div>
          </dl>

          <div>
            <p className="text-xs text-mute">Vaults on the contract (get_lifecycle_battle)</p>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {proof.communities.map((c) => {
                const won = proof.winner === c.index;
                return (
                  <li
                    key={c.token}
                    className={`flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 ${won ? "border-neon-green bg-neon-green/10" : "border-edge bg-panel"}`}
                  >
                    <span className="flex items-center gap-2">
                      {won && <Trophy size={16} className="text-neon-amber" aria-label="Winner" />}
                      <span className="font-pixel font-semibold">{c.symbol}</span>
                      <Ext href={link(`/address/${c.token}`)}>token</Ext>
                    </span>
                    <span className="font-mono text-sm">{formatAmount(c.vault, c.decimals)}</span>
                  </li>
                );
              })}
            </ul>
          </div>

          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-mute">Round winner (get_lifecycle_round)</dt>
              <dd className="font-pixel font-semibold">
                {proof.winner === null
                  ? "Not decided yet"
                  : `${proof.communities[proof.winner]?.symbol ?? `Crew ${proof.winner + 1}`} · round ${proof.roundId ?? "?"}`}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-mute">Winners&apos; DAO vote (get_lifecycle_disposition)</dt>
              <dd className="font-mono text-xs">
                {proof.dao
                  ? (() => {
                      const winner = proof.winner === null ? null : proof.communities[proof.winner];
                      const dec = winner?.decimals ?? null;
                      return `${proof.dao.status} · burn ${formatAmount(proof.dao.burn, dec)} · return ${formatAmount(proof.dao.return, dec)} · released ${proof.dao.released}/${proof.dao.total}`;
                    })()
                  : "No vote yet"}
              </dd>
            </div>
          </dl>

          <div>
            <p className="text-xs text-mute">Verify it yourself (near-cli-rs)</p>
            <div className="mt-2 flex items-start gap-2 rounded-2xl bg-ink p-3">
              <code className="min-w-0 flex-1 break-all font-mono text-xs text-void">{command}</code>
              <button
                type="button"
                onClick={() => void copy()}
                aria-label="Copy command"
                className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-xl border border-white/20 px-3 text-xs text-void"
              >
                <Copy size={14} aria-hidden /> {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
