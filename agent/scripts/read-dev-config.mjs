import path from "node:path";
import { fileURLToPath } from "node:url";

export const agentDirectory = fileURLToPath(new URL("../", import.meta.url));
export const sharedManifest = fileURLToPath(new URL("../../config/arena.testnet.reads.json", import.meta.url));
const legacyManifest = path.resolve(agentDirectory, ".agent-state/arena.testnet.reads.json");

/** Migrate only the former default snapshot; preserve intentional custom deployments. */
export function resolveDevManifest(configured) {
  const value = configured?.trim();
  if (!value || path.resolve(agentDirectory, value) === legacyManifest) return sharedManifest;
  return path.resolve(agentDirectory, value);
}
