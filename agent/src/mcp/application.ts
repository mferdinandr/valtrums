import { createHash, randomUUID } from "node:crypto";
import type { ReportArchive } from "../audit/report-archive.js";
import { canonicalJson } from "../audit/report-archive.js";
import { queryObservations } from "../audit/report-query.js";
import type { ReferenceRegistrySource } from "../reference-registry.js";
import { buildSnapshot } from "../reference-registry.js";
import { readApplicationBattle, readApplicationRound } from "./application-adapter.js";
import type { VersionedLifecycleReadSource } from "./application-adapter.js";
import {
  APPLICATION_SCHEMA, integer, manifestSchema, namespaceKey, namespaceOf, safeId,
  type ApplicationBattleSummary, type ApplicationEnvelope, type Capability, type Deployment, type Namespace, type ResolvedCapabilities,
} from "./application-contract.js";
import { UnsafeReadBoundaryError, type ArenaReadSource } from "./read-source.js";
import { DEFAULT_LIMIT, MAX_SCAN, parseSearchParams, SearchValidationError } from "./search.js";
import type { ObservationState } from "../observations/journal.js";
import { ObservationQueryError, provisionalProjection, queryObservations as queryMarketObservations, roundCoverage, type FrozenRound } from "../observations/query.js";
import type { Mode } from "../observations/schema.js";
import type { OracleStatus } from "../lifecycle-oracle/status.js";
import { assessCustody, type CustodyFacts } from "../custody-compat.js";

export interface ApplicationBinding {
  source?: ArenaReadSource;
  versioned?: VersionedLifecycleReadSource;
  registry?: ReferenceRegistrySource;
  /** Archive v1 lacks network/protocol: require an explicit, deployment-bound producer handoff. */
  audits?: { archive: Pick<ReportArchive, "snapshot">; namespace: Namespace };
  /**
   * Persisted market observations for this deployment. `load` replays the journal read-only and throws
   * when it is missing or corrupt; the service then reports the capability degraded, never an empty chart.
   */
  /** Lifecycle oracle status (read-only file written by the oracle process). It reports; it authorizes nothing. */
  oracle?: { namespace: Namespace; load(): Promise<OracleStatus>; staleAfterMs: number };
  /**
   * Source-chain custody paths this deployment would accept deposits through (#148). Each is checked with
   * `assessCustody`: source transfers are enabled only if there is at least one path and every path is
   * spendable by the payout signer. Operator configuration, never model or client input.
   */
  custody?: { namespace: Namespace; paths: ReadonlyArray<CustodyFacts & { label: string }> };
  observations?: {
    namespace: Namespace;
    load(): Promise<ObservationState>;
    /** Modes provider qualification (#147 / testnet owner) has approved; empty means no score is shown. */
    qualifiedModes: ReadonlySet<Mode>;
    /** Approved boundary tolerance and maximum sample gap (ms). Absent: coverage and scores stay unavailable. */
    coveragePolicy: { boundaryToleranceMs: number; maxGapMs: number } | null;
  };
}
export class ApplicationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const invalid = (message: string): never => { throw new ApplicationError(400, "invalid_query", message); };
const digest = (v: unknown): string => createHash("sha256").update(canonicalJson(v)).digest("hex");
export const applicationRoute = (path: string): boolean =>
  /^(capabilities|health|battles|assets|battles\/[1-9][0-9]{0,19}(?:\/(?:audits|observations))?)$/.test(path);

/** Versioned facade inside the existing MCP HTTP server; no actions or account routes. */
export class ApplicationReads {
  readonly deployments: Deployment[];
  private readonly bindings: ReadonlyMap<string, ApplicationBinding>;
  constructor(manifest: unknown, bindings: ReadonlyMap<string, ApplicationBinding>, private readonly now = Date.now) {
    this.deployments = manifestSchema.parse(manifest);
    this.bindings = new Map(bindings);
    for (const d of this.deployments) {
      const b = bindings.get(d.deploymentId);
      if (b?.source && (b.source.info.network !== d.network ||
        (d.adapter === "fixture" ? b.source.info.kind !== "fixture" : b.source.info.kind !== "live" || b.source.info.name !== d.arenaContract))) {
        throw new Error("application source does not match manifest");
      }
      if (b?.audits && namespaceKey(b.audits.namespace) !== namespaceKey(namespaceOf(d))) throw new Error("foreign audit archive binding");
      if (b?.observations && namespaceKey(b.observations.namespace) !== namespaceKey(namespaceOf(d))) throw new Error("foreign observation journal binding");
      if (b?.oracle && namespaceKey(b.oracle.namespace) !== namespaceKey(namespaceOf(d))) throw new Error("foreign oracle status binding");
      if (b?.custody && namespaceKey(b.custody.namespace) !== namespaceKey(namespaceOf(d))) throw new Error("foreign custody binding");
    }
  }

  private availability(d: Deployment) {
    const binding = this.bindings.get(d.deploymentId);
    const declared = structuredClone(d.capabilities);
    const capabilities: ResolvedCapabilities = { ...declared,
      observations: declared.observations ?? { enabled: false, reasons: ["observations capability not declared in the deployment manifest"] },
      oracle: declared.oracle ?? { enabled: false, reasons: ["oracle status capability not declared in the deployment manifest"] },
      custody: declared.custody ?? { enabled: false, reasons: ["custody capability not declared in the deployment manifest"] } };
    for (const key of Object.keys(capabilities) as Capability[]) {
      const c = capabilities[key];
      if (d.protocol !== "lifecycle-v2") { c.enabled = false; c.reasons.push("legacy-v1 remains on the explicit legacy adapter; v1 projection unsupported"); }
      else if ((key === "battles" || key === "detail") && !binding?.source) { c.enabled = false; c.reasons.push("read source unavailable"); }
      else if (key === "assets" && !binding?.registry) { c.enabled = false; c.reasons.push("trusted reference registry unavailable"); }
      else if (key === "audits" && !binding?.audits) { c.enabled = false; c.reasons.push("archive namespace handoff unavailable (#145)"); }
      else if (key === "observations" && !binding?.observations) { c.enabled = false; c.reasons.push("observation journal handoff unavailable (#146)"); }
      else if (key === "oracle" && !binding?.oracle) { c.enabled = false; c.reasons.push("oracle status handoff unavailable (#147)"); }
      else if (key === "custody" && !binding?.custody) { c.enabled = false; c.reasons.push("no custody path configured: source-chain transfers and payouts stay disabled (#148)"); }
    }
    return { ...d, capabilities, canonicalDiscovery: { enabled: false, reasons: ["verified deployment and complete live canonical projection coverage required (#144/#80)"] } };
  }

  private envelope<T>(d: Deployment, data: T, reasons: string[], snapshot: string | null = null,
    kind: ApplicationEnvelope<T>["provenance"]["kind"] = d.adapter): ApplicationEnvelope<T> {
    return {
      schemaVersion: APPLICATION_SCHEMA, namespace: namespaceOf(d),
      provenance: {
        kind, fetchedAtMs: integer(this.now()), observedAtMs: null, readModelVersion: snapshot, watermark: null,
        sourceReferences: [d.abi.evidence], finality: kind === "fixture" ? "not-applicable" : "unknown",
        health: reasons.length ? "degraded" : "healthy", complete: reasons.length === 0, reasons,
      }, data,
    };
  }

  private paginate<T>(items: T[], params: Record<string, string>, d: Deployment, resource: string, version: unknown) {
    const { cursor, ...filters } = params;
    const query = parseSearchParams({ limit: params.limit });
    const snapshot = digest([namespaceOf(d), d.abi, resource, version]);
    const normalizedFilters = Object.fromEntries(Object.entries(filters).filter(([, v]) => v.trim() !== "")
      .map(([k, v]) => [k, k === "q" ? v.trim().toLowerCase() : v]));
    normalizedFilters.limit = String(query.limit ?? DEFAULT_LIMIT);
    const scope = digest([namespaceOf(d), resource, normalizedFilters]);
    let offset = 0;
    if (cursor) {
      if (!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) invalid("malformed cursor");
      let c: { scope?: string; snapshot?: string; offset?: number };
      try { c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { return invalid("malformed cursor"); }
      if (!c || c.scope !== scope) invalid("foreign cursor or changed filters");
      if (c.snapshot !== snapshot) throw new ApplicationError(409, "snapshot_changed", "snapshot changed; restart without cursor");
      if (!Number.isSafeInteger(c.offset) || c.offset! < 0 || c.offset! > items.length) invalid("malformed cursor offset");
      offset = c.offset!;
    }
    const end = offset + (query.limit ?? DEFAULT_LIMIT);
    return { snapshot, data: { items: items.slice(offset, end), nextCursor: end < items.length
      ? Buffer.from(JSON.stringify({ scope, snapshot, offset: end })).toString("base64url") : null, truncated: false } };
  }

  /**
   * Persisted observation evidence for one battle (and optionally one round/community), with coverage
   * and a PROVISIONAL exact-score projection. The contract's recorded round/winner is returned in a
   * separate field and is the only authority; nothing here resolves a battle. A missing, unreadable or
   * corrupt journal is a 503, never an empty chart and never a fixture fallback.
   */
  private async observations(d: Deployment, binding: ApplicationBinding, id: string, params: Record<string, string>, partial: string[]) {
    const obs = binding.observations!;
    const num = (key: string, max: number): number | undefined => {
      const v = params[key];
      if (v === undefined) return undefined;
      if (!/^(0|[1-9][0-9]*)$/.test(v) || Number(v) > max) invalid(`invalid ${key}`);
      return Number(v);
    };
    const limit = params.limit === undefined ? DEFAULT_LIMIT : Number(params.limit);
    const community = num("community", 15);
    const after = num("after", Number.MAX_SAFE_INTEGER);
    for (const key of ["round", "observedFrom", "observedTo"]) if (params[key] !== undefined && !/^(0|[1-9][0-9]{0,19})$/.test(params[key]!)) invalid(`invalid ${key}`);
    let state: ObservationState;
    try { state = await obs.load(); }
    catch { throw new ApplicationError(503, "observations_unavailable", "observation journal is missing, unreadable or corrupt; recovery is documented in the agent runbook"); }
    let page;
    try {
      page = queryMarketObservations(state, { namespace: obs.namespace, battleId: id, ...(params.round !== undefined ? { roundId: params.round } : {}),
        ...(community !== undefined ? { community } : {}), ...(after !== undefined ? { afterSeq: after } : {}), limit,
        ...(params.observedFrom !== undefined ? { observedFromMs: params.observedFrom } : {}), ...(params.observedTo !== undefined ? { observedToMs: params.observedTo } : {}) });
    } catch (e) { if (e instanceof ObservationQueryError) return invalid(e.message); throw e; }

    const reasons = [...partial, "samples are persisted evidence; display polling is not provider cadence"];
    // Frozen round facts come from the contract view, never from the observations.
    let recorded: { roundId: string; winner: number | null; candidates: number[]; startNs: string | null; endNs: string | null } | null = null;
    let frozen: FrozenRound | null = null;
    const battle = binding.versioned ? await binding.versioned.battle(id).catch(() => null) : null;
    const round = binding.versioned ? await binding.versioned.round(id).catch(() => null) : null;
    if (round) recorded = { roundId: round.round_id, winner: round.winner, candidates: round.candidates, startNs: round.start_ns, endNs: round.end_ns };
    if (!battle || !round) reasons.push("frozen round facts unavailable; coverage and scores withheld");
    else if (params.round !== undefined && params.round !== round.round_id) reasons.push("round window is only known for the current round; coverage and scores withheld");
    else if (!round.start_ns || !round.end_ns) reasons.push("round window not recorded yet; coverage and scores withheld");
    else if (!battle.observation_policy_hash) reasons.push("frozen observation policy hash unavailable; coverage and scores withheld");
    else if (!obs.coveragePolicy) reasons.push("no approved coverage policy configured; coverage and scores withheld");
    else frozen = { namespace: obs.namespace, battleId: id, roundId: round.round_id, mode: battle.mode, policyHash: battle.observation_policy_hash,
      candidates: round.candidates, startNs: round.start_ns, endNs: round.end_ns, ...obs.coveragePolicy };
    const coverage = frozen ? roundCoverage(state, frozen) : null;
    const projection = frozen ? provisionalProjection(state, frozen, obs.qualifiedModes) : null;
    if (projection?.status === "unavailable") reasons.push(...projection.reasons);
    // The label comes from the samples themselves (their own `source.kind`), never from configuration.
    const kinds = [...new Set(page.items.map((i) => i.observation.source.kind))].sort();
    const sourceKind = kinds.includes("fixture") ? "fixture" : kinds.includes("recorded") ? "recorded" : kinds.includes("live") ? "live" : "none";
    if (sourceKind === "fixture") reasons.push("fixture samples: not live provider evidence");
    else if (sourceKind === "recorded") reasons.push("recorded samples: not a live feed");
    else if (sourceKind === "none") reasons.push("no samples in this page");
    if (kinds.length > 1) reasons.push(`mixed sample sources on this page: ${kinds.join(", ")}`);
    const response = this.envelope(d, {
      battleId: id, sourceKind, sourceKinds: kinds,
      items: page.items.map((i) => ({ seq: integer(i.seq), id: i.id, ...i.observation })),
      nextCursor: page.nextCursor, truncated: page.truncated,
      revision: integer(page.revision), retractedSinceCursor: page.retractedSinceCursor,
      recorded, coverage, projection,
    }, reasons, digest([namespaceOf(d), page.watermark, page.revision]), "market");
    response.provenance.watermark = integer(page.watermark.seq);
    response.provenance.sourceReferences = [d.abi.evidence, page.watermark.headHash];
    response.provenance.health = sourceKind === "live" && !coverage?.communities.some((c) => !c.complete) && reasons.length === partial.length + 1 ? "healthy" : "degraded";
    response.provenance.complete = !!coverage && coverage.communities.every((c) => c.complete);
    return response;
  }

  async read(path: string, search: URLSearchParams): Promise<unknown> {
    if (!applicationRoute(path)) throw new ApplicationError(404, "not_found", "unknown application read route");
    const params: Record<string, string> = {};
    for (const [k, v] of search) {
      if (Object.hasOwn(params, k)) invalid("duplicate query parameter");
      if (v.length > 1024) invalid("query parameter too long");
      params[k] = v;
    }
    if (path === "capabilities") {
      if (Object.keys(params).length) invalid("capabilities takes no parameters");
      return { schemaVersion: APPLICATION_SCHEMA, deployments: this.deployments.map((d) => this.availability(d)) };
    }
    const d = this.deployments.find((d) => d.deploymentId === params.deployment && d.protocol === params.protocol);
    if (!d) return invalid("unknown deployment/protocol");
    delete params.deployment; delete params.protocol;
    const binding = this.bindings.get(d.deploymentId) ?? {};
    const capability: Capability | null = path === "health" ? null : path === "assets" ? "assets" : path.endsWith("/audits") ? "audits" : path.endsWith("/observations") ? "observations" : path === "battles" ? "battles" : "detail";
    const allowed = capability === "battles" ? ["q", "mode", "status", "community", "limit", "cursor"]
      : capability === "assets" ? ["q", "limit", "cursor"] : capability === "audits" ? ["community", "limit", "cursor"]
        : capability === "observations" ? ["round", "community", "after", "limit", "observedFrom", "observedTo"] : [];
    if (Object.keys(params).some((k) => !allowed.includes(k))) invalid("unknown query parameter");
    if (params.limit !== undefined && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(params.limit)) invalid("limit must be 1 to 50");
    if (capability && !this.availability(d).capabilities[capability].enabled) {
      throw new ApplicationError(422, "unsupported_capability", this.availability(d).capabilities[capability].reasons.join("; "));
    }
    const partial = d.adapter === "rpc" ? ["RPC views are not an atomic canonical snapshot; source block/time unavailable (#144)"] : ["recorded fixture; not live deployment evidence"];
    if (path === "health") {
      const availability = this.availability(d);
      const probes: Array<[Capability, () => Promise<unknown>]> = [
        ["battles", async () => binding.versioned ? binding.versioned.count() : integer(await binding.source!.battleCount())],
        ["detail", async () => binding.versioned ? binding.versioned.count() : integer(await binding.source!.battleCount())],
        ["assets", async () => binding.registry!.load()],
        ["audits", async () => binding.audits!.archive.snapshot()],
        ["observations", async () => binding.observations!.load()],
        ["oracle", async () => binding.oracle!.load()],
        ["custody", async () => binding.custody!.paths],
      ];
      const components = await Promise.all(probes.map(async ([key, probe]) => {
        const c = availability.capabilities[key];
        if (!c.enabled) return [key, { health: "unavailable", reasons: c.reasons }];
        if (key === "custody") {
          const paths = binding.custody!.paths;
          const rows = paths.map((p) => ({ label: p.label, ...assessCustody(p) }));
          const enabled = rows.length > 0 && rows.every((r) => r.spendable);
          // Always degraded: a configured path is an operator assertion, not live proof that a payout works (#80).
          return [key, { health: "degraded", reasons: [...partial, enabled ? "every configured custody path is spendable by the payout signer (operator-configured facts, not a live payout proof)" : "source-chain transfers and payouts are disabled", ...(rows.length === 0 ? ["no custody path is configured"] : []), ...rows.flatMap((r) => r.reasons.map((reason) => `${r.label}: ${reason}`))],
            details: { sourceTransfersEnabled: enabled, paths: rows } }];
        }
        if (key === "oracle") {
          try {
            const st = await binding.oracle!.load();
            const stale = this.now() - Number(st.updatedAtMs) > binding.oracle!.staleAfterMs;
            const rows = Object.values(st.battles);
            const holding = rows.filter((r) => ["pending_evidence", "blocked", "needs_rounds_started", "error"].includes(r.phase));
            const reasons = [...(st.passError ? [`oracle pass error: ${st.passError}`] : []), ...(stale ? ["oracle status is stale: the oracle process may be down"] : []),
              ...(st.writesEnabled ? [] : ["oracle writes are disabled (dry run)"]),
              ...holding.slice(0, 10).map((r) => `battle ${r.battleId} ${r.phase}: ${r.reasons[0] ?? r.lastError ?? "no reason recorded"}`)];
            return [key, { health: "degraded", reasons: [...partial, "status is the oracle's own report, not chain authority", ...reasons],
              details: { updatedAtMs: st.updatedAtMs, passes: st.passes, writesEnabled: st.writesEnabled, passError: st.passError, stale,
                battles: rows.slice(0, 20).map((r) => ({ battleId: r.battleId, phase: r.phase, roundId: r.roundId, reasons: r.reasons, lastError: r.lastError, updatedAtMs: r.updatedAtMs })) } }];
          } catch { return [key, { health: "unavailable", reasons: ["oracle status missing or unreadable"] }]; }
        }
        try { await probe(); return [key, { health: "degraded", reasons: [...partial, "probe succeeded; canonical completeness not established"] }]; }
        catch { return [key, { health: "unavailable", reasons: ["dependency read failed"] }]; }
      }));
      return this.envelope(d, { ...availability, components: Object.fromEntries(components) }, partial);
    }
    if (capability === "battles") {
      const { cursor: _cursor, ...filters } = params;
      const q = parseSearchParams(filters);
      const source = binding.source!;
      const count = binding.versioned ? await binding.versioned.count() : integer(await source.battleCount());
      if (!binding.versioned && BigInt(count) > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApplicationError(422, "unsupported_boundary", "safe count view required (#144)");
      const items: ApplicationBattleSummary[] = [];
      for (let id = BigInt(count), scanned = 0; id >= 1n && scanned < MAX_SCAN; id--, scanned++) {
        const b = binding.versioned ? await binding.versioned.battle(String(id)) : await readApplicationBattle(source, String(id));
        if (!b) continue;
        const round = b.locked ? binding.versioned ? await binding.versioned.round(String(id)) : await readApplicationRound(source, String(id)) : null;
        const winner = round?.winner ?? null;
        const status = !b.locked ? "open" : winner === null ? "locked" : "decided";
        items.push({ battleId: String(id), creator: b.creator, mode: b.mode, status, winner,
          communities: b.communities.map((c, index) => ({ index, representation: c.representation, tokenAddress: c.token_address, chainId: c.chain_id })) });
      }
      const filtered = items.filter((b) => (!q.mode || b.mode === q.mode) && (!q.status || b.status === q.status) &&
        (!q.community || b.communities.some((c) => c.representation === q.community)) &&
        (!q.q || [b.battleId, b.creator, ...b.communities.flatMap((c) => [c.representation, c.tokenAddress])].some((v) => v.toLowerCase().includes(q.q!))));
      const page = this.paginate(filtered, params, d, path, [count, items]);
      page.data.truncated = BigInt(count) > BigInt(MAX_SCAN);
      return this.envelope(d, page.data, [...partial, ...(page.data.truncated ? ["only latest 200 battle IDs searched; older discovery requires #144"] : [])], page.snapshot);
    }
    if (capability === "assets") {
      const q = parseSearchParams({ q: params.q, limit: params.limit });
      const registry = await binding.registry!.load();
      // Revalidate custom/injected registry sources, including their committed entry digests.
      const checked = buildSnapshot(integer(registry.version), registry.entries.map((e) => ({
        chain_id: integer(e.chainId), token_address: e.token, reference_chain_id: integer(e.referenceChainId),
        reference_address: e.referenceToken, entry_hash: registry.hashes.get(`${e.chainId}:${e.token.toLowerCase()}`) ?? "",
      })));
      const items = checked.entries.map((e) => ({ ...e, assetKey: `${e.chainId}:${e.token}`, registryVersion: checked.version,
        registryEntryHash: checked.hashes.get(`${e.chainId}:${e.token}`), eligibility: "notEstablished" as const }))
        .sort((a, b) => a.assetKey.localeCompare(b.assetKey));
      const page = this.paginate(items.filter((e) => !q.q || [e.assetKey, e.referenceToken].some((v) => v.includes(q.q!))), params, d, path, items);
      return this.envelope(d, page.data, [...partial, "registry membership is not current audit, backing or deposit eligibility"], page.snapshot);
    }
    const id = path.split("/")[1]!;
    if (capability === "observations") {
      try { integer(id); } catch { return invalid("battle id is outside the u64 range"); }
      return this.observations(d, binding, id, params, partial);
    }
    try { integer(id); if (!binding.versioned || capability === "audits") safeId(id); }
    catch { throw new ApplicationError(422, "unsupported_boundary", capability === "audits" ? "archive v1 only supports safe numeric battle IDs" : "safe lifecycle ID view required (#144)"); }
    if (capability === "audits") {
      const query = parseSearchParams({ limit: params.limit });
      const community = params.community === undefined ? undefined : Number(params.community);
      if (community !== undefined && (!/^(0|[1-9][0-9]*)$/.test(params.community!) || !Number.isInteger(community) || community > 255)) invalid("invalid community index");
      const observations = await binding.audits!.archive.snapshot();
      const selected = observations.filter((o) => o.domain.arena === d.arenaContract && o.attribution.battleId === safeId(id) &&
        (community === undefined || o.attribution.community === community));
      const page = this.paginate(selected, params, d, path, selected);
      const views = queryObservations(page.data.items, { arena: d.arenaContract, battleId: safeId(id), pageSize: query.limit ?? DEFAULT_LIMIT }, new Date(this.now()));
      const response = this.envelope(d, { ...page.data, items: views.items.map((v) => ({ ...v, seq: integer(v.seq),
        attribution: { ...v.attribution, battleId: integer(v.attribution.battleId) } })), state: selected.length ? "historical" : "missing", currentApproval: "notEstablished" },
        ["archive v1 network/protocol attribution is an explicit operator handoff, not verified chain evidence", "historical reports retain individual fixture/recorded/live labels; no current approval"], page.snapshot, "aggregate");
      response.provenance.sourceReferences = views.items.map((v) => v.observationId);
      response.provenance.watermark = selected.length ? integer(selected.reduce((max, o) => Math.max(max, o.seq), 0)) : null;
      return response;
    }
    const battle = binding.versioned ? await binding.versioned.battle(id) : await readApplicationBattle(binding.source!, id);
    if (!battle) throw new ApplicationError(404, "not_found", "battle not found");
    let round = null;
    const reasons = [...partial, "exact-score/window history requires qualified versioned event backfill"];
    if (battle.locked) {
      try { round = binding.versioned ? await binding.versioned.round(id) : await readApplicationRound(binding.source!, id); if (!round) reasons.push("current round unavailable"); }
      catch { reasons.push("current round read failed"); }
    }
    let readiness = null; let history = null;
    if (binding.versioned) {
      try { readiness = await binding.versioned.readiness(id); } catch { reasons.push("versioned readiness read unavailable"); }
      try { history = await binding.versioned.history(id); } catch { reasons.push("stored history read unavailable"); }
    } else reasons.push("versioned activation/config/backing readiness unavailable");
    return this.envelope(d, { battleId: id, battle, round, readiness, history }, reasons);
  }
}

export async function handleApplicationRead(method: string | undefined, path: string, search: URLSearchParams, service?: ApplicationReads) {
  try {
    if (!applicationRoute(path)) throw new ApplicationError(404, "not_found", "unknown application read route");
    if (method !== "GET") throw new ApplicationError(405, "method_not_allowed", "method not allowed");
    if (!service) throw new ApplicationError(503, "upstream_unavailable", "application manifest is not configured");
    return { status: 200, body: JSON.stringify(await service.read(path, search)) };
  } catch (error) {
    const e = error instanceof ApplicationError ? error : error instanceof UnsafeReadBoundaryError
      ? new ApplicationError(422, "unsupported_boundary", "unsupported lifecycle read boundary; safe versioned views required (#144)") : error instanceof SearchValidationError
      ? new ApplicationError(400, "invalid_query", error.message) : new ApplicationError(503, "upstream_unavailable", "application read source unavailable");
    return { status: e.status, body: JSON.stringify({ schemaVersion: APPLICATION_SCHEMA, requestId: randomUUID(),
      error: { code: e.code, message: e.message, retryable: e.status === 503 || e.status === 409 } }) };
  }
}
