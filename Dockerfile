# Production image for the read-only Apple Search Ads MCP server (HTTP transport by default).
# - multi-stage build, small Alpine runtime, runs as the unprivileged "node" user
# - no credentials are baked in: mount accounts.json (and key files) at runtime
#
#   docker build -t apple-search-ads-mcp .
#   docker run -p 8080:8080 -v ./config/accounts.json:/app/config/accounts.json:ro \
#     -e MCP_AUTH_TOKEN=change-me-to-a-long-random-value apple-search-ads-mcp

ARG NODE_IMAGE=node:22-alpine

# ---------------------------------------------------------------- build stage
# Runs on the build machine's native platform ($BUILDPLATFORM), never under QEMU: Node 22 crashes when
# emulated (e.g. arm64 on an amd64 CI runner: "qemu: uncaught target signal 4 (Illegal instruction)").
# The output is pure JavaScript - enforced by check-pure-js.mjs below - so one build serves every
# target platform; the runtime stage only copies it onto the target platform's base image.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /build
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY scripts/postbuild.mjs ./scripts/postbuild.mjs
COPY docker/check-pure-js.mjs ./docker/check-pure-js.mjs
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && rm -rf node_modules/.cache \
 && node docker/check-pure-js.mjs node_modules

# ---------------------------------------------------------------- runtime stage
FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="apple-search-ads-mcp" \
      org.opencontainers.image.description="Read-only (GET-only) MCP server for the Apple Search Ads / Apple Ads APIs" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=8080 \
    ACCOUNTS_CONFIG=/app/config/accounts.json \
    LOG_LEVEL=info \
    REQUEST_TIMEOUT=30000

WORKDIR /app
# Application files are owned by root and only readable by the runtime user (immutable at runtime).
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY docker/healthcheck.mjs ./docker/healthcheck.mjs
# The runtime never needs a package manager: remove npm/npx/corepack/yarn to shrink the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && mkdir -p /app/config && chmod 0755 /app/config

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/app/docker/healthcheck.mjs"]

ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["--transport", "http"]
