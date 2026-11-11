import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { resolveDevManifest } from "./read-dev-config.mjs";

const rootEnv = new URL("../../.env", import.meta.url);
const key = existsSync(rootEnv) ? parseEnv(readFileSync(rootEnv, "utf8")).FASTNEAR_API_KEY : undefined;
const local = existsSync(".env.local") ? parseEnv(readFileSync(".env.local", "utf8")) : {};
const manifest = resolveDevManifest(process.env.ARENA_APPLICATION_MANIFEST_PATH ?? local.ARENA_APPLICATION_MANIFEST_PATH);
console.log(`[read-dev] manifest: ${manifest}`);
const child = spawn(process.execPath, ["--env-file-if-exists=.env.local", "dist/mcp/cli.js", "http"], {
  stdio: "inherit",
  env: { ...process.env, ...(key ? { FASTNEAR_API_KEY: key } : {}), ARENA_APPLICATION_MANIFEST_PATH: manifest },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
