# AI Agent Sandbox Environment
# A comprehensive development environment for AI agents to execute various tasks

FROM ubuntu:24.04

LABEL maintainer="Tiger Data"
LABEL description="Comprehensive sandbox environment for AI agents"

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
  httpie \
  netcat-openbsd \
  dnsutils \
  iputils-ping \
  openssh-client \
  # Archive & compression
  zip \
  unzip \
  tar \
  gzip \
  bzip2 \
  xz-utils \
  p7zip-full \
  # Text processing & editors
  vim \
  nano \
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
  # Database clients (PostgreSQL installed separately below)
  redis-tools \
  sqlite3 \
  # SSL & certificates
  ca-certificates \
  openssl \
  gnupg \
  # Misc utilities
  locales \
  tzdata \
  file \
  bc \
  uuid-runtime \
  # Libraries for various tools
  libssl-dev \
  libffi-dev \
  zlib1g-dev \
  libbz2-dev \
  libreadline-dev \
  libsqlite3-dev \
  libncurses5-dev \
  libncursesw5-dev \
  liblzma-dev \
  libxml2-dev \
  libxslt1-dev \
  libpq-dev \
  # X11 and display libraries (for headless browsers)
  xvfb \
  xauth \
  libx11-xcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxi6 \
  libxtst6 \
  libnss3 \
  libcups2 \
  libxss1 \
  libxrandr2 \
  libasound2t64 \
  libpangocairo-1.0-0 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libgtk-3-0 \
  libgbm1 \
  libdrm2 \
  libxkbcommon0 \
  fonts-liberation \
  fonts-noto-color-emoji \
  # Media processing
  ffmpeg \
  imagemagick \
  libmagickwand-dev \
  # OCR & document processing
  tesseract-ocr \
  tesseract-ocr-eng \
  poppler-utils \
  ghostscript \
  wkhtmltopdf \
  # Diagramming & visualization
  graphviz \
  # Metadata tools
  libimage-exiftool-perl \
  # PDF Generation
  pandoc \
  texlive-latex-base \
  texlive-latex-recommended \
  texlive-latex-extra \
  texlive-fonts-recommended \
  texlive-xetex \
  latexmk \
  # Python
  python3 \
  python3-full \
  python3-venv \
  python3-dev \
  python3-pip \
  && rm -rf /var/lib/apt/lists/*

# ============================================================================
# POSTGRESQL 18 (Full installation including psql)
# Using official PGDG repository - https://www.postgresql.org/download/linux/ubuntu/
# ============================================================================
RUN apt-get update && apt-get install -y postgresql-common \
  && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
  && apt-get update \
  && apt-get install -y \
  postgresql-18 \
  postgresql-client-18 \
  postgresql-doc-18 \
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

# Global npm packages
RUN bun install -g \
  typescript \
  tsx \
  yarn \
  prettier \
  eslint

# Set Python 3 as default
RUN update-alternatives --install /usr/bin/python python /usr/bin/python3 1

# Essential Python packages
RUN pip install --no-cache-dir --break-system-packages --ignore-installed \
  # Package management
  setuptools \
  wheel \
  pipx \
  uv \
  poetry \
  # Web & HTTP
  requests \
  httpx \
  aiohttp \
  fastapi \
  uvicorn \
  flask \
  # Data processing
  pandas \
  numpy \
  polars \
  # CLI & utilities
  click \
  typer \
  rich \
  pydantic \
  python-dotenv \
  # Testing
  pytest \
  pytest-asyncio \
  # Code quality
  black \
  ruff \
  mypy \
  # Scraping & automation
  beautifulsoup4 \
  lxml \
  selenium \
  playwright \
  # Database
  psycopg2-binary \
  sqlalchemy \
  # Async
  asyncio \
  anyio \
  # Document & media processing
  pypdf \
  python-docx \
  openpyxl \
  markdown \
  pytesseract \
  Pillow \
  opencv-python-headless \
  # CSV processing
  csvkit \
  # Misc
  pyyaml \
  toml \
  jinja2

# ============================================================================
# GO (Golang)
# ============================================================================

ENV GO_VERSION=1.25.5
RUN ARCH=$(dpkg --print-architecture) && \
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" | tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:/root/go/bin:$PATH"
ENV GOPATH="/root/go"

# Go debugger
RUN go install github.com/go-delve/delve/cmd/dlv@latest

# ============================================================================
# RUST (via rustup)
# ============================================================================

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:$PATH"

# Common Rust tools
RUN cargo install \
  tokei \
  hyperfine \
  bat \
  eza

# ============================================================================
# HEADLESS BROWSER AUTOMATION
# ============================================================================

# Install Playwright browsers (Chromium, Firefox, WebKit) - works on both amd64 and arm64
RUN playwright install --with-deps chromium firefox webkit \
  && ln -s /root/.cache/ms-playwright/chromium-*/chrome-linux/chrome /usr/local/bin/chromium

# Install Puppeteer (will use Playwright's Chromium)
RUN bun install -g puppeteer

# ============================================================================
# CLOUD CLIs & INFRASTRUCTURE TOOLS
# ============================================================================

# AWS CLI v2
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" \
  && unzip awscliv2.zip \
  && ./aws/install \
  && rm -rf awscliv2.zip aws

# Azure CLI
RUN curl -sL https://aka.ms/InstallAzureCLIDeb | bash

# Terraform
RUN wget -O- https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" > /etc/apt/sources.list.d/hashicorp.list \
  && apt-get update \
  && apt-get install -y terraform \
  && rm -rf /var/lib/apt/lists/*

# kubectl
RUN curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.31/deb/Release.key | gpg --dearmor -o /usr/share/keyrings/kubernetes-apt-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.31/deb/ /" > /etc/apt/sources.list.d/kubernetes.list \
  && apt-get update \
  && apt-get install -y kubectl \
  && rm -rf /var/lib/apt/lists/*

# Helm
RUN curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Docker (daemon + CLI for Docker-in-Docker scenarios)
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

# ============================================================================
# ADDITIONAL UTILITIES
# ============================================================================

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# ngrok (tunneling)
RUN curl -fsSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null \
  && echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | tee /etc/apt/sources.list.d/ngrok.list \
  && apt-get update \
  && apt-get install -y ngrok \
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
  && mkdir -p /home/${USER_NAME}/.cache

# Copy tools installed in root's home to agent's home
RUN cp -r /root/.bun /home/${USER_NAME}/.bun \
  && cp -r /root/.cargo /home/${USER_NAME}/.cargo \
  && cp -r /root/.rustup /home/${USER_NAME}/.rustup \
  && cp -r /root/go /home/${USER_NAME}/go \
  && cp -r /root/.cache/ms-playwright /home/${USER_NAME}/.cache/ms-playwright \
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
    "/app": {
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
ENV PATH="/home/${USER_NAME}/.local/bin:/home/${USER_NAME}/.bun/bin:/home/${USER_NAME}/.cargo/bin:/home/${USER_NAME}/go/bin:/usr/local/go/bin:$PATH"
ENV BUN_INSTALL="/home/${USER_NAME}/.bun"
ENV GOPATH="/home/${USER_NAME}/go"

# Environment variables for browser automation
ENV PLAYWRIGHT_BROWSERS_PATH=/home/${USER_NAME}/.cache/ms-playwright
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chromium
ENV CHROME_BIN=/usr/local/bin/chromium

RUN  git config --global user.email "conductor@tigerdata.com" \
  && git config --global user.name "Conductor Agent"


# Create working directory
WORKDIR /work

# Default command
CMD ["/bin/bash"]
