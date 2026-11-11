import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";

const rootEnv = new URL("../../.env", import.meta.url);
const key = existsSync(rootEnv) ? parseEnv(readFileSync(rootEnv, "utf8")).FASTNEAR_API_KEY : undefined;
const child = spawn(process.execPath, ["--env-file-if-exists=.env.local", "dist/mcp/cli.js", "http"], {
  stdio: "inherit",
  env: { ...process.env, ...(key ? { FASTNEAR_API_KEY: key } : {}) },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
