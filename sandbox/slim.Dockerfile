FROM ubuntu:24.04

LABEL maintainer="Tiger Data"
LABEL description="Minimal sandbox environment for AI agents"
LABEL org.opencontainers.image.source=https://github.com/timescale/hermes

# Pinned tool versions — override at build time with --build-arg
# Canonical values live in sandbox/versions.json
ARG CLAUDE_CODE_VERSION=latest
ARG OPENCODE_VERSION=latest

RUN apt-get update && apt-get install -y --no-install-recommends \
  git \
  curl \
  ca-certificates \
  zip \
  unzip \
  tar \
  gzip \
  jq \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /.hermes/signal && chmod 777 /.hermes/signal \
  && cat <<'ENTRY' > /.hermes/signalEntrypoint.sh && chmod +x /.hermes/signalEntrypoint.sh
#!/bin/sh
# wait for ready signal, then start
while [ ! -f /.hermes/signal/.ready ]; do
  sleep 0.1
done
exec "$@"
ENTRY

# ============================================================================
# NON-ROOT USER SETUP
# ============================================================================

# Create non-root user (required for claude --dangerously-skip-permissions)
ARG USER_NAME=hermes
ARG USER_UID=10000
ARG USER_GID=10000

RUN groupadd --gid ${USER_GID} ${USER_NAME} \
  && useradd --uid ${USER_UID} --gid ${USER_GID} -m ${USER_NAME} \
  && mkdir -p /home/${USER_NAME}/.local/bin \
  && mkdir -p /home/${USER_NAME}/.local/share/opencode \
  && mkdir -p /home/${USER_NAME}/.cache \
  && mkdir -p /home/${USER_NAME}/.config/gh \
  && mkdir -p /home/${USER_NAME}/.claude \
  && chown -R ${USER_NAME}:${USER_NAME} /home/${USER_NAME}

# Install claude code as non-root user
USER ${USER_NAME}
RUN curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_CODE_VERSION}

# tiger CLI
RUN curl -fsSL https://cli.tigerdata.com | sh

# opencode
RUN curl -fsSL https://opencode.ai/install | bash -s -- --version ${OPENCODE_VERSION}
RUN ln -s /home/${USER_NAME}/.opencode/bin/opencode /home/${USER_NAME}/.local/bin/opencode


ENV HOME="/home/${USER_NAME}"
ENV PATH="/home/${USER_NAME}/.local/bin:$PATH"
# Prevent Claude Code from auto-updating past the pinned version
ENV DISABLE_AUTOUPDATER=1

RUN  git config --global user.email "hermes@tigerdata.com" \
  && git config --global user.name "Hermes Agent"

# Create working directory
WORKDIR /work

# Default command
CMD ["/bin/bash"]
