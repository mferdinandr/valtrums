import { access, readFile } from "node:fs/promises";
import type { ViewFn } from "./read-source.js";
import { FixtureArenaReadSource, NearArenaReadSource } from "./read-source.js";
import { battleSchema, roundSchema, VersionedLifecycleReadSource } from "./application-adapter.js";
import { manifestSchema, namespaceKey, namespaceOf, safeId } from "./application-contract.js";
import { ApplicationReads, type ApplicationBinding } from "./application.js";
import { NearReferenceRegistrySource, staticReferenceRegistry } from "../reference-registry.js";
import { JsonFileReportArchive } from "../audit/report-archive.js";
import { z } from "zod";

const fixtureSchema = z.object({
  battles: z.array(z.object({ id: z.string(), battle: battleSchema, round: roundSchema.nullable() }).strict()).max(200),
  registry: z.array(z.object({ chainId: z.string(), token: z.string(), referenceChainId: z.string(), referenceToken: z.string() }).strict()).max(256),
}).strict();

/** Optional extension to read:serve. Per-network view clients are injected without signing keys. */
export async function loadApplicationReads(env: NodeJS.ProcessEnv, views: (network: "testnet" | "mainnet") => ViewFn) {
  const manifestPath = env.ARENA_APPLICATION_MANIFEST_PATH?.trim();
  if (!manifestPath) return undefined;
  const deployments = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const bindings = new Map<string, ApplicationBinding>();
  for (const d of deployments) {
    let binding: ApplicationBinding = {};
    if (d.protocol === "lifecycle-v2" && d.adapter === "rpc") {
      const view = views(d.network === "near-testnet" ? "testnet" : "mainnet");
      binding = {
        ...(d.abi.version === "lifecycle-application-v1" ? { versioned: new VersionedLifecycleReadSource(d.arenaContract, view) } : {}),
        source: new NearArenaReadSource({ network: d.network, kind: "live", name: d.arenaContract }, view, { arena: d.arenaContract, payout: d.companions.payout }),
        ...(d.companions.registry === d.arenaContract ? { registry: new NearReferenceRegistrySource(d.arenaContract, { view: async <T>(c: string, m: string, a: Record<string, unknown>) => await view(c, m, a) as T }) } : {}),
      };
    } else if (d.adapter === "fixture") {
      const path = env.ARENA_APPLICATION_FIXTURE_PATH?.trim();
      if (!path || deployments.filter((d) => d.adapter === "fixture").length !== 1) throw new Error("fixture adapter requires a dedicated fixture file and deployment");
      const fixture = fixtureSchema.parse(JSON.parse(await readFile(path, "utf8")));
      const ids = fixture.battles.map((b) => safeId(b.id));
      if (new Set(ids).size !== ids.length) throw new Error("duplicate fixture battle ID");
      binding.source = new FixtureArenaReadSource(d.network, {
        battles: new Map(fixture.battles.map((b) => [safeId(b.id), b.battle])),
        rounds: new Map(fixture.battles.flatMap((b) => b.round ? [[safeId(b.id), b.round] as const] : [])),
      });
      binding.registry = staticReferenceRegistry(fixture.registry);
    }
    if (env.ARENA_APPLICATION_AUDIT_SCOPE && env.AUDIT_ARCHIVE_PATH) {
      const scope = JSON.parse(env.ARENA_APPLICATION_AUDIT_SCOPE);
      if (namespaceKey(scope) === namespaceKey(namespaceOf(d))) {
        const path = env.AUDIT_ARCHIVE_PATH;
        const archive = new JsonFileReportArchive(path);
        binding.audits = { archive: { snapshot: async () => { await access(path); return archive.snapshot(); } }, namespace: namespaceOf(d) };
      }
    }
    bindings.set(d.deploymentId, binding);
  }
  return new ApplicationReads(deployments, bindings);
}
