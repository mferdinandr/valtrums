"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useActionWallet, useWallet } from "@/components/providers";
import type { AccountStateData } from "@/lib/arena-read/account-state";
import { ActionSession } from "@/lib/arena-read/action-session";
import { applicationKey, fetchApplication, type Namespace } from "@/lib/arena-read/application";
import { fetchReadTool, type ReadEnvelope, type ReadToolName } from "@/lib/arena-read/client";
import {
  LatestRead,
  type CustodyHealth,
  type DeploymentCapabilities,
  type PayoutItem,
  type PositionsData,
} from "@/lib/arena-read/portfolio";

export type Part<T> = { state: "ok"; env: ReadEnvelope<T> } | { state: "error"; message: string };

type EntitlementsData = { accountId: string; available: boolean; entitlements: unknown[] };
type PayoutsData = { accountId: string; payouts: PayoutItem[] };

export interface PortfolioData {
  accountState: Part<AccountStateData>;
  positions: Part<PositionsData>;
  entitlements: Part<EntitlementsData>;
  payouts: Part<PayoutsData>;
}

export type LoadState =
  | { step: "idle" }
  | { step: "opening-session" }
  | { step: "reading" }
  | { step: "ready"; data: PortfolioData; account: string }
  | { step: "error"; message: string };

async function part<T>(tool: ReadToolName, session: string, signal: AbortSignal): Promise<Part<T>> {
  try {
    return { state: "ok", env: await fetchReadTool<T>(tool, new URLSearchParams(), { session, signal }) };
  } catch (e) {
    return { state: "error", message: e instanceof Error ? e.message : "read failed" };
  }
}

/**
 * Account reads through the wallet NEP-413 session. The session token is memory-only (ActionSession) and is
 * dropped with the account. Every load aborts the previous one and only the newest sequence for the current
 * account may commit, so a slow response for account A can never appear under account B.
 */
export function usePortfolio() {
  const { accountId } = useWallet();
  const getWallet = useActionWallet();
  const [state, setState] = useState<LoadState>({ step: "idle" });
  const guard = useRef(new LatestRead());
  const session = useRef<{ account: string; value: ActionSession } | null>(null);

  // A different account or a sign-out discards the session, in-flight reads and every displayed value.
  useEffect(() => {
    guard.current.cancel();
    session.current?.value.invalidate();
    session.current = null;
    setState({ step: "idle" });
  }, [accountId]);
  useEffect(() => () => guard.current.cancel(), []);

  const load = useCallback(async () => {
    if (!accountId || !getWallet) return;
    const read = guard.current.begin(accountId);
    setState({ step: "opening-session" });
    try {
      const wallet = await getWallet();
      if (session.current?.account !== accountId) session.current = { account: accountId, value: new ActionSession({ accountId, wallet }) };
      const token = await session.current.value.ensure();
      if (!read.isCurrent()) return;
      setState({ step: "reading" });
      const [accountState, positions, entitlements, payouts] = await Promise.all([
        part<AccountStateData>("inspect_account_state", token, read.signal),
        part<PositionsData>("inspect_positions", token, read.signal),
        part<EntitlementsData>("inspect_entitlements", token, read.signal),
        part<PayoutsData>("inspect_payouts", token, read.signal),
      ]);
      if (!read.isCurrent()) return;
      setState({ step: "ready", account: accountId, data: { accountState, positions, entitlements, payouts } });
    } catch (e) {
      if (read.isCurrent()) setState({ step: "error", message: e instanceof Error ? e.message : "could not read your account" });
    }
  }, [accountId, getWallet]);

  return { accountId, connected: !!accountId && !!getWallet, state, load };
}

export interface DeploymentFacts {
  capabilities: DeploymentCapabilities | null;
  custody: CustodyHealth | null;
  error: string | null;
}

/** Deployment capability and custody health. Public reads; they never need a session. */
export function useDeploymentFacts(namespace: Namespace | null): DeploymentFacts | null {
  const [facts, setFacts] = useState<{ key: string; value: DeploymentFacts } | null>(null);
  const key = namespace ? applicationKey(namespace) : null;
  useEffect(() => {
    if (!namespace || !key) return;
    const controller = new AbortController();
    void (async () => {
      let capabilities: DeploymentCapabilities | null = null;
      let custody: CustodyHealth | null = null;
      const errors: string[] = [];
      try {
        const res = await fetch("/api/arena/v1/capabilities", { cache: "no-store", signal: controller.signal });
        const body = (await res.json()) as { deployments?: DeploymentCapabilities[] };
        if (!res.ok) throw new Error("capabilities unavailable");
        capabilities = body.deployments?.find((d) => d.deploymentId === namespace.deploymentId) ?? null;
        if (!capabilities) errors.push("this deployment is not in the capability list");
      } catch (e) {
        if (!controller.signal.aborted) errors.push(e instanceof Error ? e.message : "capabilities unavailable");
      }
      try {
        const env = await fetchApplication<{ components?: { custody?: { details?: { sourceTransfersEnabled?: boolean }; reasons?: string[] } } }>(
          namespace, "health", {}, controller.signal,
        );
        const c = env.data.components?.custody;
        custody = { sourceTransfersEnabled: typeof c?.details?.sourceTransfersEnabled === "boolean" ? c.details.sourceTransfersEnabled : null, reasons: c?.reasons ?? [] };
      } catch (e) {
        if (!controller.signal.aborted) errors.push(e instanceof Error ? e.message : "health unavailable");
      }
      if (!controller.signal.aborted) setFacts({ key, value: { capabilities, custody, error: errors.length ? errors.join("; ") : null } });
    })();
    return () => controller.abort();
  }, [namespace, key]);
  return facts && facts.key === key ? facts.value : null;
}
