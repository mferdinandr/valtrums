"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@/components/providers";
import type { AccountStateData } from "@/lib/arena-read/account-state";
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

export type PayoutsData = { accountId: string; payouts: PayoutItem[] };
type EntitlementsData = { accountId: string; available: boolean; entitlements: unknown[] };

export interface PortfolioData {
  accountState: Part<AccountStateData>;
  positions: Part<PositionsData>;
  entitlements: Part<EntitlementsData>;
}

export type LoadState =
  | { step: "idle" }
  | { step: "reading" }
  | { step: "ready"; data: PortfolioData; account: string }
  | { step: "error"; message: string };

async function part<T>(tool: ReadToolName, accountId: string, signal: AbortSignal): Promise<Part<T>> {
  try {
    return { state: "ok", env: await fetchReadTool<T>(tool, new URLSearchParams({ accountId }), { signal }) };
  } catch (e) {
    return { state: "error", message: e instanceof Error ? e.message : "read failed" };
  }
}

/**
 * Account reads by account id. Positions, payouts and account state wrap public NEAR view calls, so no wallet
 * signature is needed. Every load aborts the previous one and only the newest sequence for the current account
 * may commit, so a slow response for account A can never appear under account B.
 */
export function usePortfolio() {
  const { accountId } = useWallet();
  const [state, setState] = useState<LoadState>({ step: "idle" });
  const guard = useRef(new LatestRead());

  // A different account or a sign-out discards in-flight reads and every displayed value.
  useEffect(() => {
    guard.current.cancel();
    setState({ step: "idle" });
  }, [accountId]);
  useEffect(() => () => guard.current.cancel(), []);

  const load = useCallback(async () => {
    if (!accountId) return;
    const read = guard.current.begin(accountId);
    setState({ step: "reading" });
    try {
      const [accountState, positions, entitlements] = await Promise.all([
        part<AccountStateData>("inspect_account_state", accountId, read.signal),
        part<PositionsData>("inspect_positions", accountId, read.signal),
        part<EntitlementsData>("inspect_entitlements", accountId, read.signal),
      ]);
      if (!read.isCurrent()) return;
      setState({ step: "ready", account: accountId, data: { accountState, positions, entitlements } });
    } catch (e) {
      if (read.isCurrent()) setState({ step: "error", message: e instanceof Error ? e.message : "could not read your account" });
    }
  }, [accountId]);

  return { accountId, connected: !!accountId, state, load };
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
