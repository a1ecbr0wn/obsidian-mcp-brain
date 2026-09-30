# obsidian-mcp-brain container image.
#
# The server has no runtime dependencies, so there is no install or build step:
# the application files are copied onto the Node base image as they are.
#
#   docker run -d \
#     -v /path/to/vault:/vaults/knowledge \
#     -v /path/to/obsidian-mcp.json:/config/obsidian-mcp.json:ro \
#     -p 127.0.0.1:3002:3002 \
#     ghcr.io/a1ecbr0wn/obsidian-mcp-brain
#
# The mounted config must set "listenHost": "0.0.0.0" so the published port can
# reach the server, and use container-side vault paths (e.g. /vaults/knowledge).

# node:22-alpine, pinned by digest for reproducible builds.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="obsidian-mcp-brain" \
      org.opencontainers.image.description="MCP server exposing Obsidian vaults to remote clients over HTTP" \
      org.opencontainers.image.source="https://github.com/a1ecbr0wn/obsidian-mcp-brain" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

# tini runs as PID 1 so that SIGTERM from `docker stop` reaches the server (a Node
# process that is PID 1 ignores signals it has no handler for) and so that exited
# child processes are reaped.
RUN apk add --no-cache tini

WORKDIR /app
# Files stay root-owned and world-readable whatever the build machine's umask was.
COPY --chmod=a+rX obsidian-mcp-brain/package.json obsidian-mcp-brain/obsidian-mcp-brain.mjs ./
COPY --chmod=a+rX obsidian-mcp-brain/lib ./lib
COPY --chmod=a+rX docker/healthcheck.mjs ./healthcheck.mjs

ENV CONFIG_PATH=/config/obsidian-mcp.json

USER node

# Documentation only: the port is whatever "listenPort" in the config says (default
# 3002), and the published port must match it.
EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/app/healthcheck.mjs"]

ENTRYPOINT ["/sbin/tini", "--", "node", "/app/obsidian-mcp-brain.mjs"]
