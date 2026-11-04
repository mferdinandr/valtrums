# Build from the repository root:  docker build -f agent/Dockerfile -t valtrum-agent .
# Pinned by tag; for a bit-for-bit base, additionally pin the digest (see deploy/README.md).
ARG NODE_IMAGE=node:22.21.1-slim

FROM ${NODE_IMAGE} AS base
ENV CI=true
# pnpm version comes from the root package.json "packageManager" field.
RUN corepack enable
WORKDIR /repo
# web/package.json is needed only because the lockfile covers every workspace package.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY agent/package.json agent/package.json
COPY web/package.json web/package.json

FROM base AS build
RUN pnpm install --frozen-lockfile --filter @valtrum/agent...
COPY agent/tsconfig.json agent/tsconfig.build.json agent/
COPY agent/src agent/src
RUN pnpm -F @valtrum/agent build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter @valtrum/agent...

FROM ${NODE_IMAGE} AS runtime
ARG AGENT_VERSION=unknown
ENV NODE_ENV=production \
    AGENT_VERSION=${AGENT_VERSION} \
    BASELINE_STORE_PATH=/var/lib/valtrum-agent/baselines.json \
    HEALTH_PORT=8080
# Only the state directory is writable; everything else can be mounted read-only.
RUN mkdir -p /var/lib/valtrum-agent && chown 10001:10001 /var/lib/valtrum-agent
WORKDIR /app
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=prod-deps /repo/agent/node_modules ./agent/node_modules
COPY --from=build /repo/agent/dist ./agent/dist
COPY agent/package.json ./agent/package.json
USER 10001:10001
VOLUME ["/var/lib/valtrum-agent"]
EXPOSE 8080
WORKDIR /app/agent
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||'8080')+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/main.js"]
