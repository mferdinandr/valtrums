import { type Server, createServer } from "node:http";
import { FixtureCustody } from "./custody.js";
import { FIXTURE_LABEL, FIXTURE_ROUTE, assertFixtureAllowed } from "./label.js";
import { createJsonLogger, type Logger } from "../logger.js";
import { IntentsFixtureService } from "./service.js";
import { FakeSolver, type SolverMode } from "./solver.js";

/**
 * Local HTTP front of the 1Click fixture. Loopback only, no credentials read or sent. It refuses
 * to start unless the configuration is testnet. `PUT /fixture/solver-mode` (fixture-only, not a
 * 1Click path) switches the fake solver between complete, fail and refund for demos and tests.
 */

const MAX_BODY = 64 * 1024;

export function createFixtureServer(opts: { network: string; port: number; solverMode?: SolverMode; logger?: Logger; now?: () => number }): { server: Server; service: IntentsFixtureService; custody: FixtureCustody; solver: FakeSolver } {
  assertFixtureAllowed(opts.network);
  const logger = opts.logger ?? createJsonLogger();
  const custody = new FixtureCustody();
  const solver = new FakeSolver(custody, opts.solverMode ?? "complete");
  const service = new IntentsFixtureService({ solver, network: opts.network, logger, ...(opts.now ? { now: opts.now } : {}) });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json", "x-valtrum-fixture": "true" });
        res.end(JSON.stringify(body));
      };
      if (size > MAX_BODY) return send(413, { message: "request body too large" });
      const url = req.url ?? "/";
      if (req.method === "PUT" && url === "/fixture/solver-mode") {
        try {
          const mode = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { mode?: unknown }).mode;
          if (mode !== "complete" && mode !== "fail" && mode !== "refund") return send(400, { message: "mode must be complete, fail or refund" });
          solver.setMode(mode);
          logger.info("intents-fixture solver mode", { fixture: true, route: FIXTURE_ROUTE, label: FIXTURE_LABEL, mode });
          return send(200, { mode, valtrumFixture: FIXTURE_LABEL });
        } catch {
          return send(400, { message: "invalid JSON" });
        }
      }
      let body: unknown;
      if (chunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return send(400, { message: "invalid JSON" });
        }
      }
      const out = service.handle({ method: req.method ?? "GET", url, ...(body !== undefined ? { body } : {}) });
      res.writeHead(out.status, out.headers);
      res.end(JSON.stringify(out.body));
    });
  });
  return { server, service, custody, solver };
}

/** Starts on 127.0.0.1 only. */
export function listenFixture(opts: Parameters<typeof createFixtureServer>[0]): Promise<ReturnType<typeof createFixtureServer>> {
  const made = createFixtureServer(opts);
  return new Promise((resolve, reject) => {
    made.server.once("error", reject);
    made.server.listen(opts.port, "127.0.0.1", () => resolve(made));
  });
}
