import { type Server, createServer } from "node:http";

export interface AttestationInfo {
  /** Digest of the running image, injected by the deployer (it cannot be known at build time). */
  imageDigest: string;
  version: string;
  agentAccountId: string;
  executionMode: string;
  contractId: string;
}

/** Tracks the outcome of the last pass; the only mutable state the endpoints read. */
export class HealthState {
  private lastSuccessMs: number | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  markPassSucceeded(): void {
    this.lastSuccessMs = this.now();
  }

  /** Ready = a pass succeeded within the last three intervals. */
  isReady(): boolean {
    return this.lastSuccessMs !== undefined && this.now() - this.lastSuccessMs <= 3 * this.intervalMs;
  }
}

/** Reads only the non-secret, public fields. Takes values explicitly so no secret can reach it. */
export function attestationFromEnv(
  env: Record<string, string | undefined>,
  fields: Pick<AttestationInfo, "agentAccountId" | "executionMode" | "contractId">,
): AttestationInfo {
  return {
    imageDigest: env.IMAGE_DIGEST?.trim() || "unknown",
    version: env.AGENT_VERSION?.trim() || "unknown",
    ...fields,
  };
}

export interface HealthResponse {
  status: number;
  body: unknown;
}

export function handleHealthRequest(
  method: string | undefined,
  path: string,
  state: HealthState,
  info: AttestationInfo,
): HealthResponse {
  if (method !== "GET" && method !== "HEAD") return { status: 405, body: { error: "method not allowed" } };
  switch (path) {
    case "/healthz":
      return { status: 200, body: { status: "ok" } };
    case "/readyz": {
      const ready = state.isReady();
      return { status: ready ? 200 : 503, body: { ready } };
    }
    case "/attestation":
      return {
        status: 200,
        body: {
          image_digest: info.imageDigest,
          version: info.version,
          agent_account_id: info.agentAccountId,
          execution_mode: info.executionMode,
          contract_id: info.contractId,
        },
      };
    default:
      return { status: 404, body: { error: "not found" } };
  }
}

/** Dependency-free HTTP server. Returns undefined when the port is 0 (disabled). */
export function startHealthServer(
  port: number,
  state: HealthState,
  info: AttestationInfo,
  host = "0.0.0.0",
): Promise<Server | undefined> {
  if (port === 0) return Promise.resolve(undefined);
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const out = handleHealthRequest(req.method, path, state, info);
    res.writeHead(out.status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(out.body));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

export function parseHealthPort(env: Record<string, string | undefined>): number {
  const raw = env.HEALTH_PORT?.trim();
  if (!raw) return 8080;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error("HEALTH_PORT must be an integer between 0 and 65535");
  }
  return n;
}
