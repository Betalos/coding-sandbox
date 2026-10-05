FROM node:current-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g corepack opencode-ai @anthropic-ai/claude-code @caveman-ai/cli \
 && corepack enable \
 && npm cache clean --force
# Caveman companion binaries live in a read-only path; its runtime state goes to CAVEMAN_HOME (tmpfs under HOME)
RUN CAVEMAN_HOME=/opt/caveman caveman setup --install
WORKDIR /app
COPY package.json ./
COPY src ./src
# the base image's user `node` (uid 1000); HOME is a tmpfs when the root filesystem is read-only
ENV HOME=/home/node WORKSPACE=/workspace PORT=8080 CLAUDE_WRAP=caveman CAVEMAN_HOME=/home/node/.caveman \
    CAVEMAN_PROXY_BIN=/opt/caveman/bin/caveman-proxy CAVEMAN_ENGINE_BIN=/opt/caveman/bin/caveman-engine CAVEMAN_MCP_BIN=/opt/caveman/bin/caveman-mcp \
    CAVEMAN_SHRINK_BIN=/opt/caveman/bin/caveman-shrink CAVEMAN_BROWSE_BIN=/opt/caveman/bin/caveman-browse
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
