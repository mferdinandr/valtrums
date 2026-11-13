"use client";

import { Coins, Flame, Layers } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ClaimAllButton } from "@/components/claim-all-button";
import { TokenIcon } from "@/components/token-icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import type { PortfolioData } from "@/hooks/use-portfolio";
import { formatUnits } from "@/lib/amounts";
import { daoBlocksClaim } from "@/lib/arena-read/account-state";
import { TOKEN_DECIMALS } from "@/lib/arena-read/balances";
import { symbolOf } from "@/lib/arena-read/claim";
import { normalizePositions } from "@/lib/arena-read/portfolio";
import { readBattleBriefs, STAGE_ORDER, STAGE_TITLE, type BattleBrief, type BattleStage } from "@/lib/arena-read/position-status";
import { config } from "@/lib/config";

const units = (v: string): string => (/^(0|[1-9][0-9]*)$/.test(v) ? formatUnits(BigInt(v), TOKEN_DECIMALS, 4) : v);

const TONES = {
  green: { background: "#327f7d22", color: "#327f7d" },
  amber: { background: "#a8802f22", color: "#a8802f" },
  rose: { background: "#ad527322", color: "#ad5273" },
  blue: { background: "#5b6fb522", color: "#5b6fb5" },
  grey: { background: "#e6e2d6", color: "#526777" },
} as const;

function Chip({ tone, children }: { tone: keyof typeof TONES; children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold" style={TONES[tone]}>
      {children}
    </span>
  );
}

function Tile({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string | number; tone: keyof typeof TONES }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: "#fffdf6", border: "1px solid #d8dfd3" }}>
      <span className="grid h-9 w-9 place-items-center rounded-xl" style={TONES[tone]}>{icon}</span>
      <p className="mt-3 text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-xs text-mute">{label}</p>
    </div>
  );
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {hint && <p className="text-xs text-mute">{hint}</p>}
      </div>
      {children}
    </Card>
  );
}

function Row({ symbol, title, sub, chip }: { symbol: string; title: ReactNode; sub?: ReactNode; chip?: ReactNode }) {
  return (
    <li className="flex items-center gap-3 rounded-xl p-3" style={{ background: "#fffdf6", border: "1px solid #d8dfd3" }}>
      <TokenIcon symbol={symbol} size={36} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold tabular-nums">{title}</p>
        {sub && <p className="truncate text-xs text-mute">{sub}</p>}
      </div>
      {chip}
    </li>
  );
}

const POSITIONS_PAGE = 5;

function chipFor(stage: BattleStage, winner: number | null, community: number): ReactNode {
  if (stage === "finished") return <Chip tone={winner === community ? "green" : "grey"}>{winner === community ? "Won" : "Lost"}</Chip>;
  if (stage === "open") return <Chip tone="green">Deposits open</Chip>;
  if (stage === "live") return <Chip tone="blue">In play</Chip>;
  return <Chip tone="amber">Refundable</Chip>;
}

const Empty = ({ children }: { children: ReactNode }) => <p className="text-sm text-mute">{children}</p>;

/**
 * The portfolio at a glance: four tiles, then what is ready to claim, the positions, the DAO decisions and the
 * transfers. Sources, freshness and limitations stay available under "Details"; nothing is hidden or assumed.
 */
export function PortfolioView({ data, arena, onChanged }: { data: PortfolioData; arena: string; onChanged: () => void }) {
  const positions = data.positions.state === "ok" ? data.positions.env.data.positions : null;
  const state = data.accountState.state === "ok" ? data.accountState.env.data : null;
  const claimable = (state?.entitlements ?? []).filter((e) => /^[0-9]+$/.test(e.available) && BigInt(e.available) > 0n);
  const dao = state?.daoPrincipal ?? [];
  const waiting = daoBlocksClaim(state);
  const groups = data.positions.state === "ok" ? normalizePositions(data.positions.env.data) : [];
  // Only deposits count as positions; a joined community without a deposit is not shown.
  const rows = groups.flatMap((g) => g.rows.filter((r) => r.valid && r.amount !== "0").map((r) => ({ ...r, asset: g.asset })));
  const ids = useMemo(() => [...new Set(rows.map((r) => r.battleId))].sort((a, b) => a - b), [rows]);
  const idKey = ids.join(",");
  const [briefs, setBriefs] = useState<Map<number, BattleBrief> | null>(null);
  useEffect(() => {
    let live = true;
    readBattleBriefs(config.rpcUrl, arena, ids).then((m) => live && setBriefs(m)).catch(() => live && setBriefs(new Map()));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arena, idKey]);
  const byStage = (stage: BattleStage) => rows.filter((r) => briefs?.get(r.battleId)?.stage === stage);
  const unknown = briefs === null ? rows : rows.filter((r) => !briefs.has(r.battleId));
  const sections: Array<{ key: string; title: string; stage: BattleStage | null; list: typeof rows }> = [
    ...STAGE_ORDER.map((stage) => ({ key: stage, title: STAGE_TITLE[stage], stage, list: byStage(stage) })),
    ...(briefs !== null ? [{ key: "unknown", title: "Status unavailable", stage: null, list: unknown }] : []),
  ].filter((x) => x.list.length > 0);
  const [filter, setFilter] = useState("all");
  const [visible, setVisible] = useState<Record<string, number>>({});
  // A filter whose section disappeared (for example after a refresh) falls back to all.
  const activeFilter = filter === "all" || sections.some((x) => x.key === filter) ? filter : "all";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <Tile icon={<Layers size={18} aria-hidden="true" />} label="Battles joined" value={positions === null ? "–" : ids.length} tone="blue" />
        <Tile icon={<Coins size={18} aria-hidden="true" />} label="Ready to claim" value={state === null ? "–" : claimable.length} tone="green" />
        <Tile icon={<Flame size={18} aria-hidden="true" />} label="In DAO decision" value={state === null ? "–" : dao.length} tone="rose" />
      </div>

      <Panel title="Ready to claim" hint="Goes to your NEAR wallet, 1:1 with the source custody.">
        {state === null ? (
          <Empty>This could not be read right now. Nothing is assumed about what you can claim.</Empty>
        ) : claimable.length === 0 ? (
          <Empty>Nothing to claim yet. Prizes appear here after a battle is settled.</Empty>
        ) : (
          <>
            <ul className="space-y-2">
              {claimable.map((e) => (
                <Row key={e.backing} symbol={symbolOf(e.backing)} title={`${units(e.available)} ${symbolOf(e.backing)}`} sub="Claimable" />
              ))}
            </ul>
            {waiting && <p className="text-xs text-mute">A DAO decision is still running. Claim after it finishes.</p>}
            <ClaimAllButton backings={claimable.map((e) => e.backing)} onDone={onChanged} disabled={waiting} label={claimable.length > 1 ? "Claim all to my NEAR wallet" : undefined} />
          </>
        )}
      </Panel>

      <Panel title="Your positions">
        {positions === null ? (
          <Empty>Positions could not be read right now.</Empty>
        ) : rows.length === 0 ? (
          <Empty>No deposits in recent battles.</Empty>
        ) : (
          <div className="space-y-4">
            <Select
              label="Filter positions by battle status"
              value={activeFilter}
              onChange={setFilter}
              options={[
                { value: "all", title: `All battles (${rows.length})` },
                ...sections.map((x) => ({ value: x.key, title: `${x.title} (${x.list.length})` })),
              ]}
            />
            {sections
              .filter((x) => activeFilter === "all" || activeFilter === x.key)
              .map((x) => {
                const shown = Math.min(x.list.length, visible[x.key] ?? POSITIONS_PAGE);
                return (
                  <section key={x.key} aria-label={`${x.title} positions`} className="space-y-2">
                    <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-mute">
                      {x.title}
                      <span className="rounded-full px-2 py-0.5 text-[11px]" style={TONES.grey}>{x.list.length}</span>
                    </h3>
                    <ul className="space-y-2">
                      {x.list.slice(0, shown).map((r) => (
                        <Row
                          key={r.key}
                          symbol={symbolOf(r.asset)}
                          title={`${units(r.amount)} ${symbolOf(r.asset)}`}
                          sub={<Link href={`/arena/${r.battleId}`} className="underline">Battle #{r.battleId}</Link>}
                          chip={x.stage ? chipFor(x.stage, briefs?.get(r.battleId)?.winner ?? null, r.community) : undefined}
                        />
                      ))}
                    </ul>
                    {x.list.length > POSITIONS_PAGE && (
                      <div className="flex gap-2">
                        {shown < x.list.length && (
                          <Button type="button" variant="ghost" onClick={() => setVisible((v) => ({ ...v, [x.key]: shown + POSITIONS_PAGE }))}>
                            Show more ({x.list.length - shown})
                          </Button>
                        )}
                        {shown > POSITIONS_PAGE && (
                          <Button type="button" variant="ghost" onClick={() => setVisible((v) => ({ ...v, [x.key]: POSITIONS_PAGE }))}>
                            Show less
                          </Button>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
          </div>
        )}
      </Panel>

      <Panel title="DAO decisions" hint="Your winning principal: burn or keep.">
        {state === null ? (
          <Empty>This could not be read right now.</Empty>
        ) : dao.length === 0 ? (
          <Empty>No winning principal in a DAO decision.</Empty>
        ) : (
          <ul className="space-y-2">
            {dao.map((d) => {
              const tone = d.voteStatus === "voting" ? "green" : d.voteStatus === "decided" ? "blue" : "amber";
              const label = d.voteStatus === "voting" ? "Voting open" : d.voteStatus === "decided" ? "Decided" : d.voteStatus === "no_vote" ? "No vote" : d.voteStatus === "undecided_escrowed" ? "No votes" : "Pending";
              return (
                <Row
                  key={`${d.battleId}:${d.community}`}
                  symbol="DAO"
                  title={`Your principal ${units(d.position)}`}
                  sub={
                    <>
                      <Link href={`/arena/${d.battleId}`} className="underline">Battle #{d.battleId}</Link>
                      {d.myReturn ? ` · return ${units(d.myReturn.amount)}${d.myReturn.recorded ? "" : " (not recorded yet)"}` : ""}
                    </>
                  }
                  chip={<Chip tone={tone}>{label}</Chip>}
                />
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
