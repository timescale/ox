# AI Agent Sandbox Environment
# A comprehensive development environment for AI agents to execute various tasks
#
# Build modes:
#   Slim (default): docker build -t hermes-sandbox .
#   Full:           docker build --build-arg SLIM=false -t hermes-sandbox:full .

FROM ubuntu:24.04

LABEL maintainer="Tiger Data"
LABEL description="Comprehensive sandbox environment for AI agents"

# Build argument to control slim vs full image
# SLIM=true (default) creates a smaller image with lazy-loaded tools
# SLIM=false creates a full image with all tools pre-installed
ARG SLIM=true

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# Set locale
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# ============================================================================
# SYSTEM PACKAGES & CORE UTILITIES
# ============================================================================

RUN apt-get update && apt-get install -y --no-install-recommends \
  # Essential build tools (always included for basic compilation)
  build-essential \
  gcc \
  g++ \
  make \
  cmake \
  pkg-config \
  autoconf \
  automake \
  libtool \
  # Version control
  git \
  git-lfs \
  # Networking & download tools
  curl \
  ca-certificates \
  wget \
  openssh-client \
  # Archive & compression
  zip \
  unzip \
  tar \
  gzip \
  bzip2 \
  # Text processing & editors
  vim \
  jq \
  yq \
  ripgrep \
  fd-find \
  fzf \
  tree \
  less \
  # Process & system utilities
  htop \
  procps \
  lsof \
  strace \
  # SSL & certificates
  ca-certificates \
  openssl \
  gnupg \
  # Misc utilities
  locales \
  tzdata \
  # Python
  python3 \
  python3-full \
  python3-venv \
  python3-dev \
  python3-pip \
  && rm -rf /var/lib/apt/lists/*

# ============================================================================
# POSTGRESQL
# Using official PGDG repository - https://www.postgresql.org/download/linux/ubuntu/
# Full: postgresql-18 server + client
# Slim: postgresql-client-18 only (psql)
# ============================================================================
RUN apt-get update && apt-get install -y postgresql-common \
  && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
  && apt-get update \
  && if [ "$SLIM" = "true" ]; then \
       apt-get install -y postgresql-client-18; \
     else \
       apt-get install -y postgresql-18 postgresql-client-18 postgresql-doc-18; \
     fi \
  && rm -rf /var/lib/apt/lists/*

# Add PostgreSQL binaries to PATH
ENV PATH="/usr/lib/postgresql/18/bin:$PATH"


# ============================================================================
# NODE.JS (via NodeSource - Latest LTS)
# ============================================================================

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g npm@latest

# ============================================================================
# BUN (JavaScript runtime & toolkit)
# ============================================================================

RUN curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL="/root/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"

# Set Python 3 as default
RUN update-alternatives --install /usr/bin/python python /usr/bin/python3 1

# Essential Python packages
RUN pip install --no-cache-dir --break-system-packages --ignore-installed \
  # Package management
  pipx \
  uv \
  poetry

# ============================================================================
# GO (Golang)
# Full: Install directly
# Slim: Lazy-loaded via wrapper script
# ============================================================================

ENV GO_VERSION=1.25.5

RUN if [ "$SLIM" != "true" ]; then \
      ARCH=$(dpkg --print-architecture) && \
      curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" | tar -C /usr/local -xzf - && \
      export PATH="/usr/local/go/bin:$PATH" && \
      export GOPATH="/root/go" && \
      go install github.com/go-delve/delve/cmd/dlv@latest; \
    fi

# Only set Go paths for full image
ENV PATH="/usr/local/go/bin:/root/go/bin:$PATH"
ENV GOPATH="/root/go"

# ============================================================================
# DOCKER
# Full: Install via apt (daemon + CLI)
# Slim: Lazy-loaded via wrapper script
# ============================================================================

RUN if [ "$SLIM" != "true" ]; then \
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg && \
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list && \
      apt-get update && \
      apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin && \
      rm -rf /var/lib/apt/lists/*; \
    fi

# ============================================================================
# ADDITIONAL UTILITIES
# ============================================================================

# GitHub CLI (always included - essential for PR workflow)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# ngrok (tunneling)
# Full: Install via apt
# Slim: Lazy-loaded via wrapper script
RUN if [ "$SLIM" != "true" ]; then \
      curl -fsSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null && \
      echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | tee /etc/apt/sources.list.d/ngrok.list && \
      apt-get update && \
      apt-get install -y ngrok && \
      rm -rf /var/lib/apt/lists/*; \
    fi

# ============================================================================
# NON-ROOT USER SETUP
# ============================================================================

# Create non-root user (required for claude --dangerously-skip-permissions)
ARG USER_NAME=agent
ARG USER_UID=10000
ARG USER_GID=10000

RUN groupadd --gid ${USER_GID} ${USER_NAME} \
  && useradd --uid ${USER_UID} --gid ${USER_GID} -m ${USER_NAME} \
  && mkdir -p /home/${USER_NAME}/.local/bin \
  && mkdir -p /home/${USER_NAME}/.local/share/opencode \
  && mkdir -p /home/${USER_NAME}/.cache \
  && mkdir -p /home/${USER_NAME}/.config/gh \
  && mkdir -p /home/${USER_NAME}/.claude \
  && mkdir -p /home/${USER_NAME}/.hermes-tools \
  && chown ${USER_NAME}:${USER_NAME} /home/${USER_NAME}/.hermes-tools

# Copy tools installed in root's home to agent's home
# For slim builds, only copy bun (Go is lazy-loaded)
RUN cp -r /root/.bun /home/${USER_NAME}/.bun \
  && if [ "$SLIM" != "true" ] && [ -d /root/go ]; then \
       cp -r /root/go /home/${USER_NAME}/go; \
     else \
       mkdir -p /home/${USER_NAME}/go; \
     fi \
  && chown -R ${USER_NAME}:${USER_NAME} /home/${USER_NAME}

# ============================================================================
# LAZY TOOL LOADING (Slim image only)
# ============================================================================

# Create the installer script inline (no COPY needed - works without build context)
RUN cat <<'INSTALLER_EOF' > /usr/local/bin/hermes-tool-install
#!/bin/bash
set -e
TOOLS_DIR="/home/agent/.hermes-tools"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
info() { echo -e "${YELLOW}$1${NC}"; }
success() { echo -e "${GREEN}$1${NC}"; }
error() { echo -e "${RED}$1${NC}" >&2; }

install_go() {
  local VERSION="${GO_VERSION:-1.25.5}"
  local INSTALL_DIR="$TOOLS_DIR/go"
  [ -f "$INSTALL_DIR/.installed" ] && return 0
  info "Installing Go $VERSION (first time only)..."
  mkdir -p "$INSTALL_DIR"
  local ARCH
  case "$(uname -m)" in
    x86_64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) error "Unsupported architecture: $(uname -m)"; exit 1 ;;
  esac
  info "  Downloading go${VERSION}.linux-${ARCH}.tar.gz..."
  curl -fsSL "https://go.dev/dl/go${VERSION}.linux-${ARCH}.tar.gz" | tar -C "$INSTALL_DIR" --strip-components=1 -xzf -
  echo "version=$VERSION" > "$INSTALL_DIR/.installed"
  echo "installed_at=$(date -Iseconds)" >> "$INSTALL_DIR/.installed"
  success "  Go installed successfully!"
}

install_docker() {
  local INSTALL_DIR="$TOOLS_DIR/docker"
  [ -f "$INSTALL_DIR/.installed" ] && return 0
  info "Installing Docker (first time only)..."
  mkdir -p "$INSTALL_DIR/bin"
  local ARCH
  case "$(uname -m)" in
    x86_64) ARCH="x86_64" ;;
    aarch64|arm64) ARCH="aarch64" ;;
    *) error "Unsupported architecture: $(uname -m)"; exit 1 ;;
  esac
  local DOCKER_VERSION="27.4.1"
  info "  Downloading docker-${DOCKER_VERSION}.tgz..."
  curl -fsSL "https://download.docker.com/linux/static/stable/${ARCH}/docker-${DOCKER_VERSION}.tgz" | tar -C "$INSTALL_DIR/bin" --strip-components=1 -xzf -
  local COMPOSE_VERSION="v2.32.4"
  info "  Downloading docker-compose..."
  curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${ARCH}" -o "$INSTALL_DIR/bin/docker-compose"
  chmod +x "$INSTALL_DIR/bin/docker-compose"
  echo "docker_version=$DOCKER_VERSION" > "$INSTALL_DIR/.installed"
  echo "compose_version=$COMPOSE_VERSION" >> "$INSTALL_DIR/.installed"
  echo "installed_at=$(date -Iseconds)" >> "$INSTALL_DIR/.installed"
  success "  Docker installed successfully!"
}

install_ngrok() {
  local INSTALL_DIR="$TOOLS_DIR/ngrok"
  [ -f "$INSTALL_DIR/.installed" ] && return 0
  info "Installing ngrok (first time only)..."
  mkdir -p "$INSTALL_DIR/bin"
  local ARCH
  case "$(uname -m)" in
    x86_64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) error "Unsupported architecture: $(uname -m)"; exit 1 ;;
  esac
  info "  Downloading ngrok..."
  curl -fsSL "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${ARCH}.tgz" | tar -C "$INSTALL_DIR/bin" -xzf -
  echo "version=v3-stable" > "$INSTALL_DIR/.installed"
  echo "installed_at=$(date -Iseconds)" >> "$INSTALL_DIR/.installed"
  success "  ngrok installed successfully!"
}

case "${1:-}" in
  go) install_go ;;
  docker) install_docker ;;
  ngrok) install_ngrok ;;
  all) install_go; install_docker; install_ngrok; success "All tools installed!" ;;
  *) echo "Usage: hermes-tool-install <go|docker|ngrok|all>"; exit 1 ;;
esac
INSTALLER_EOF
RUN chmod +x /usr/local/bin/hermes-tool-install

# Create wrapper scripts for slim builds (using printf to avoid heredoc issues)
RUN if [ "$SLIM" = "true" ]; then \
  printf '%s\n' '#!/bin/bash' 'TOOLS_DIR="/home/agent/.hermes-tools"' 'GO_DIR="$TOOLS_DIR/go"' '[ ! -f "$GO_DIR/.installed" ] && /usr/local/bin/hermes-tool-install go' 'export GOROOT="$GO_DIR"' 'export PATH="$GO_DIR/bin:$PATH"' 'exec "$GO_DIR/bin/go" "$@"' > /usr/local/bin/go && \
  printf '%s\n' '#!/bin/bash' 'TOOLS_DIR="/home/agent/.hermes-tools"' 'GO_DIR="$TOOLS_DIR/go"' '[ ! -f "$GO_DIR/.installed" ] && /usr/local/bin/hermes-tool-install go' 'export GOROOT="$GO_DIR"' 'export PATH="$GO_DIR/bin:$PATH"' 'exec "$GO_DIR/bin/gofmt" "$@"' > /usr/local/bin/gofmt && \
  printf '%s\n' '#!/bin/bash' 'TOOLS_DIR="/home/agent/.hermes-tools"' 'DOCKER_DIR="$TOOLS_DIR/docker"' '[ ! -f "$DOCKER_DIR/.installed" ] && /usr/local/bin/hermes-tool-install docker' 'export PATH="$DOCKER_DIR/bin:$PATH"' 'exec "$DOCKER_DIR/bin/docker" "$@"' > /usr/local/bin/docker && \
  printf '%s\n' '#!/bin/bash' 'TOOLS_DIR="/home/agent/.hermes-tools"' 'DOCKER_DIR="$TOOLS_DIR/docker"' '[ ! -f "$DOCKER_DIR/.installed" ] && /usr/local/bin/hermes-tool-install docker' 'export PATH="$DOCKER_DIR/bin:$PATH"' 'exec "$DOCKER_DIR/bin/docker-compose" "$@"' > /usr/local/bin/docker-compose && \
  printf '%s\n' '#!/bin/bash' 'TOOLS_DIR="/home/agent/.hermes-tools"' 'NGROK_DIR="$TOOLS_DIR/ngrok"' '[ ! -f "$NGROK_DIR/.installed" ] && /usr/local/bin/hermes-tool-install ngrok' 'export PATH="$NGROK_DIR/bin:$PATH"' 'exec "$NGROK_DIR/bin/ngrok" "$@"' > /usr/local/bin/ngrok && \
  chmod +x /usr/local/bin/go /usr/local/bin/gofmt /usr/local/bin/docker /usr/local/bin/docker-compose /usr/local/bin/ngrok; \
fi

# ============================================================================
# AGENT TOOLS (Claude Code, opencode, tiger CLI)
# ============================================================================

# Install claude code as non-root user
USER ${USER_NAME}
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN cat <<'EOF' > /home/${USER_NAME}/.claude.json
{
  "numStartups": 1,
  "installMethod": "native",
  "autoUpdates": false,
  "hasCompletedOnboarding": true,
  "bypassPermissionsModeAccepted": true,
  "projects": {
    "/work": {
      "allowedTools": [],
      "mcpContextUris": [],
      "mcpServers": {},
      "enabledMcpjsonServers": [],
      "disabledMcpjsonServers": [],
      "hasTrustDialogAccepted": true
    }
  }
}
EOF

# tiger CLI
RUN curl -fsSL https://cli.tigerdata.com | sh

# opencode
RUN curl -fsSL https://opencode.ai/install | bash
RUN ln -s /home/${USER_NAME}/.opencode/bin/opencode /home/${USER_NAME}/.local/bin/opencode


# ============================================================================
# ENVIRONMENT CONFIGURATION
# ============================================================================

ENV HOME=/home/${USER_NAME}
ENV PATH="/home/${USER_NAME}/.local/bin:/home/${USER_NAME}/.bun/bin:/home/${USER_NAME}/go/bin:/usr/local/go/bin:$PATH"
ENV BUN_INSTALL="/home/${USER_NAME}/.bun"
ENV GOPATH="/home/${USER_NAME}/go"

# For slim builds, also add the hermes-tools paths to PATH
# These will be populated by the lazy loader
ENV PATH="/home/${USER_NAME}/.hermes-tools/go/bin:/home/${USER_NAME}/.hermes-tools/docker/bin:/home/${USER_NAME}/.hermes-tools/ngrok/bin:$PATH"

RUN  git config --global user.email "hermes@tigerdata.com" \
  && git config --global user.name "Hermes Agent"


# Create working directory
WORKDIR /work

# Default command
CMD ["/bin/bash"]
