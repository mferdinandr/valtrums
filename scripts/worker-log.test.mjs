import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { redactWorkerLine, pipeWorkerLog } from "./worker-log.mjs";

test("RPC URLs, authorization and configured credentials are redacted", () => {
  const line = redactWorkerLine('rpc?apiKey=abcdef secret-value Bearer hidden-auth', ["secret-value"]);
  for (const secret of ["abcdef", "secret-value", "hidden-auth"]) assert.equal(line.includes(secret), false);
});
test("split chunks preserve complete log lines in terminal and archive", async () => {
  const stream = new PassThrough();
  const terminal = [], archive = [];
  const lines = pipeWorkerLog(stream, { name: "agent", secrets: ["secret-value"], archive: (line) => archive.push(line), write: (line) => terminal.push(line) });
  stream.write("audit secret-");
  stream.end("value\nfinished");
  await once(lines, "close");
  assert.deepEqual(archive, ["audit [redacted]\n", "finished\n"]);
  assert.deepEqual(terminal, ["[agent] audit [redacted]\n", "[agent] finished\n"]);
});
