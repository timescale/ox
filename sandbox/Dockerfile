# AI Agent Sandbox Environment
# Minimal base image for AI agents - project dependencies installed as needed

FROM ubuntu:24.04

LABEL maintainer="Tiger Data"
LABEL description="Minimal sandbox environment for AI agents"

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
  # Essential build tools
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
  # Text processing
  jq \
  yq \
  ripgrep \
  less \
  # Process utilities
  procps \
  # SSL & certificates
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
# POSTGRESQL CLIENT (psql only)
# Using official PGDG repository - https://www.postgresql.org/download/linux/ubuntu/
# ============================================================================
RUN apt-get update && apt-get install -y postgresql-common \
  && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
  && apt-get update \
  && apt-get install -y postgresql-client-18 \
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
# GITHUB CLI
# ============================================================================

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

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
  && mkdir -p /home/${USER_NAME}/.claude

# Copy tools installed in root's home to agent's home
RUN cp -r /root/.bun /home/${USER_NAME}/.bun \
  && chown -R ${USER_NAME}:${USER_NAME} /home/${USER_NAME}

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
ENV PATH="/home/${USER_NAME}/.local/bin:/home/${USER_NAME}/.bun/bin:$PATH"
ENV BUN_INSTALL="/home/${USER_NAME}/.bun"

RUN  git config --global user.email "hermes@tigerdata.com" \
  && git config --global user.name "Hermes Agent"


# Create working directory
WORKDIR /work

# Default command
CMD ["/bin/bash"]
