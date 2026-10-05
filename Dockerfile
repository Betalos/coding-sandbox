FROM oraclelinux:10

# Toolchain the agents need: git, a C/C++ compiler for native npm modules, python
RUN dnf install -y --setopt=install_weak_deps=False \
      git openssh-clients ca-certificates python3 tar gzip xz unzip make gcc gcc-c++ which findutils shadow-utils \
 && dnf clean all && rm -rf /var/cache/dnf

# Node.js: the newest LTS release at build time (rebuild monthly to follow it)
RUN set -eux; \
    case "$(uname -m)" in x86_64) node_arch=x64;; aarch64) node_arch=arm64;; esac; \
    ver="$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import sys,json;print(next(v["version"] for v in json.load(sys.stdin) if v["lts"]))')"; \
    curl -fsSL "https://nodejs.org/dist/${ver}/node-${ver}-linux-${node_arch}.tar.xz" | tar -xJ -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE; \
    node --version; npm --version

# Docker CLI + Compose + Buildx (client only: the daemon is somewhere else, see DOCKER_HOST). Versions are pinned; bump them on the monthly rebuild.
ARG DOCKER_VERSION=29.8.2
ARG COMPOSE_VERSION=v5.6.0
ARG BUILDX_VERSION=v0.37.2
RUN set -eux; \
    arch="$(uname -m)"; case "$arch" in x86_64) go_arch=amd64;; aarch64) go_arch=arm64;; esac; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_VERSION}.tgz" | tar -xz -C /usr/local/bin --strip-components=1 docker/docker; \
    mkdir -p /usr/local/lib/docker/cli-plugins; \
    curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${arch}" -o /usr/local/lib/docker/cli-plugins/docker-compose; \
    curl -fsSL "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-${go_arch}" -o /usr/local/lib/docker/cli-plugins/docker-buildx; \
    chmod +x /usr/local/lib/docker/cli-plugins/*; \
    docker --version; docker compose version; docker buildx version

# Agents and wrapper
RUN npm install -g corepack opencode-ai @anthropic-ai/claude-code @caveman-ai/cli \
 && corepack enable \
 && npm cache clean --force
# Caveman companion binaries live in a read-only path; its runtime state goes to CAVEMAN_HOME (tmpfs under HOME)
RUN CAVEMAN_HOME=/opt/caveman caveman setup --install \
 && chmod -R a+rX /opt/caveman

# Unprivileged user (uid 1000); HOME is a tmpfs when the root filesystem is read-only
RUN useradd -u 1000 -m -s /bin/bash node \
 && su -s /bin/sh node -c 'test -x /opt/caveman/bin/caveman-proxy'   # fails the build if the unprivileged user cannot run the Caveman binaries
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV HOME=/home/node WORKSPACE=/workspace PORT=8080 CLAUDE_WRAP=caveman CAVEMAN_HOME=/home/node/.caveman \
    CAVEMAN_PROXY_BIN=/opt/caveman/bin/caveman-proxy CAVEMAN_ENGINE_BIN=/opt/caveman/bin/caveman-engine CAVEMAN_MCP_BIN=/opt/caveman/bin/caveman-mcp \
    CAVEMAN_SHRINK_BIN=/opt/caveman/bin/caveman-shrink CAVEMAN_BROWSE_BIN=/opt/caveman/bin/caveman-browse
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
