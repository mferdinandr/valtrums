import type { ApplicationEnvelope, ApplicationPage, ApplicationBattleSummary, Namespace, Deployment } from "../../../../agent/src/mcp/application-contract";
import type { SearchInput } from "./search-controller";

export type { ApplicationEnvelope, ApplicationPage, ApplicationBattleSummary, Namespace, Deployment };
export const applicationKey = (n: Namespace): string => JSON.stringify([n.deploymentId, n.network, n.arenaContract, n.protocol]);
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function fetchApplication<T>(namespace: Namespace, path: string, input: SearchInput, signal: AbortSignal,
  doFetch: FetchLike = (u, i) => fetch(u, i)): Promise<ApplicationEnvelope<T>> {
  const query = new URLSearchParams({ deployment: namespace.deploymentId, protocol: namespace.protocol });
  for (const k of ["q", "mode", "status", "community", "limit", "cursor"]) {
    if (input[k] !== undefined && String(input[k]).trim()) query.set(k, String(input[k]).trim());
  }
  const res = await doFetch(`/api/arena/v1/${path}?${query}`, { method: "GET", cache: "no-store", signal });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? "Application reads unavailable");
  if (body?.schemaVersion !== "arena-application-v1" || !body.namespace || applicationKey(body.namespace) !== applicationKey(namespace) || !body.provenance) {
    throw new Error("Application response namespace/schema mismatch");
  }
  return body as ApplicationEnvelope<T>;
}

export type ApplicationBattlePage = ApplicationPage<ApplicationBattleSummary>;
