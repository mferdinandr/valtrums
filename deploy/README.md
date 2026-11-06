# Deploying the legacy infrastructure agent

These instructions operate the current NEAR arena. The [Robinhood rollout](../docs/deployment.md) and bounded player agents are planned. No target deployment or player authority is provided by this container.

The agent is one container: `agent/Dockerfile` (multi-stage, Node 22 slim, non-root user `10001`). Its only writable path is the state volume `/var/lib/valtrum-agent` (liquidity baselines); the root filesystem can be read-only.

## Build

From the repository root:

```bash
docker build -f agent/Dockerfile --build-arg AGENT_VERSION=0.1.0 -t valtrum-agent:0.1.0 .
```

Reproducibility notes:

- The base image is pinned by tag (`node:22.21.1-slim`, build arg `NODE_IMAGE`). Tags can move, so for a bit-for-bit base pass `--build-arg NODE_IMAGE=node:22.21.1-slim@sha256:<digest>`.
- pnpm is the version in the root `package.json` (`packageManager`), activated through corepack, and dependencies install with `--frozen-lockfile`.
- Nothing in the Dockerfile reads the clock or the network beyond the package registry. File timestamps still vary between builds, so for a byte-identical image use a recent BuildKit with `SOURCE_DATE_EPOCH` set and `--output type=image,rewrite-timestamp=true`, and compare digests across two machines (not verified here).
- Read the digest of a local image with `docker image inspect valtrum-agent:0.1.0 --format '{{.Id}}'` (the image ID), or of a pushed image with `docker buildx imagetools inspect <ref>` (the registry digest). Verifiers should compare registry digests.

## Run locally

```bash
cp deploy/.env.agent.example deploy/.env.agent   # fill in ARENA_CONTRACT_ID, AGENT_ACCOUNT_ID and one key option
docker compose -f deploy/docker-compose.yml up --build -d
curl localhost:8080/healthz
curl localhost:8080/readyz
curl localhost:8080/attestation
```

Compose runs the container with a read-only root, no capabilities, `no-new-privileges`, a named volume for state, a restart policy and a healthcheck on `/readyz`. The port is bound to loopback only.

## Secrets

The private key comes from exactly one of:

- `AGENT_PRIVATE_KEY`: the key itself, injected as an environment variable.
- `AGENT_PRIVATE_KEY_FILE`: a path to a mounted secret file; surrounding whitespace is trimmed.

Setting both, or neither, is a startup error. The key is never baked into the image, never logged, and never returned by any endpoint. Do not put it in a Dockerfile `ENV` or build arg. `deploy/.env.agent` and `deploy/secrets/` must stay out of git (the repository ignores `.env.*`).

## Endpoints

| Path | Meaning |
| --- | --- |
| `/healthz` | liveness: the process answers |
| `/readyz` | readiness: `200` if a pass finished without errors within the last 3 intervals, otherwise `503` |
| `/attestation` | JSON with `image_digest`, `version`, `agent_account_id`, `execution_mode`, `contract_id` |

`HEALTH_PORT` (default `8080`, `0` disables the server). The image's own `HEALTHCHECK` calls `/healthz`, so it reports unhealthy if you set `HEALTH_PORT=0`; override it then.

`image_digest` is whatever the operator passes as `IMAGE_DIGEST`: an image cannot contain its own digest, so the value is injected at deploy time. On its own it is a claim, not proof.

## Running in a confidential-compute (TEE) environment

The goal is that users can trust the agent runs exactly the published code and that nobody, including the host operator, can read its key. Any confidential-compute platform that offers the following works; this repository does not depend on a specific vendor.

1. **Remote attestation of the image digest.** The platform measures the workload it launches and issues a signed attestation that binds that measurement to the image digest being run. The deployment must refer to the image by digest (`repo@sha256:...`), not by a movable tag.
2. **Secrets released only to an attested workload.** The agent key is stored in the platform's key release service (or equivalent) and handed to the workload only after the attestation check passes. Supply it through `AGENT_PRIVATE_KEY_FILE` (a mounted secret) so it never appears in the process environment listing or the deployment manifest.
3. **No operator access.** Disable shell access to the workload and keep the root filesystem read-only; the state volume holds only liquidity baselines, no secrets.
4. **Publish the digest.** Set `IMAGE_DIGEST` to the deployed digest so `/attestation` reports it.

How a user or operator verifies it:

1. Rebuild the image from the tagged commit using the steps above and compute its digest (see Reproducibility notes).
2. Fetch `/attestation` and compare `image_digest` with your build. Also check `agent_account_id`, `contract_id` and `execution_mode`.
3. Compare the digest in the platform's signed attestation report with the same value. The `/attestation` response alone is self-reported; the platform's report is what proves the digest is the one that is running.
4. On chain, confirm that `agent_account_id` is the account the arena whitelisted (`add_agent`) and nothing else.

## NEAR account setup (minimum)

- A dedicated account for the agent, used for nothing else, with its own key pair. The key type (full access or restricted) is left to the operator; the agent signs every call itself.
- The arena owner whitelists it: `add_agent { account_id }` on the arena contract.
- Fund it only with gas: a few NEAR on testnet, a small buffer on mainnet, topped up when the balance falls. It never needs to hold battle funds.
- Match `EXECUTION_MODE` to the arena (`onchain` needs `execution_dex` set, `mock` needs it unset).

## Operational limits

- Liquidity baselines live in the state volume. If the volume is lost, the watchdog takes the current liquidity as the new baseline and a drop before that goes unnoticed. Keep the volume across restarts.
- Price history for TWAPs accrues from the agent's own samples; after a long outage the fetcher refuses to write prices until enough history exists.
- Final prices use the 30 minutes before the pass that settles, so settle promptly after `end_time`.
- A dispatched settlement step that never gets proceeds is logged as `STUCK STEP` and not retried; the contract has no reset method.
- Legacy foreign EVM execution exists; live signer assumptions and receipt/reporting limits are documented in [agent/README.md](../agent/README.md). Target Robinhood custody and original-token payouts remain unimplemented.
- Legacy quotes come from mock DEX rates or Ref exchange returns, depending on MARKET_DATA. Other sources require an adapter.

See [agent/README.md](../agent/README.md) for the full list.
