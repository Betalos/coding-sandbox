FROM node:current-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && npm install -g opencode-ai @anthropic-ai/claude-code \
 && npm cache clean --force
WORKDIR /app
COPY package.json ./
COPY src ./src
# the base image's user `node` (uid 1000); HOME is a tmpfs when the root filesystem is read-only
ENV HOME=/home/node WORKSPACE=/workspace PORT=8080
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
