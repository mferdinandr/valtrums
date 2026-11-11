import { createInterface } from "node:readline";

export function redactWorkerLine(line, secrets = []) {
  let safe = line;
  for (const secret of secrets.filter((v) => typeof v === "string" && v.length >= 6).sort((a, b) => b.length - a.length)) {
    safe = safe.split(secret).join("[redacted]");
    safe = safe.split(encodeURIComponent(secret)).join("[redacted]");
  }
  return safe.replace(/([?&](?:apiKey|api_key|key|token)=)[^\s"&]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [redacted]");
}

/** Tee complete lines so chunks from concurrent workers cannot interleave. */
export function pipeWorkerLog(stream, { name, secrets, archive, write }) {
  const lines = createInterface({ input: stream });
  lines.on("line", (line) => {
    const safe = redactWorkerLine(line, secrets);
    archive(`${safe}\n`);
    write(`[${name}] ${safe}\n`);
  });
  return lines;
}
