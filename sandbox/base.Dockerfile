FROM ubuntu:24.04

LABEL maintainer="Tiger Data"
LABEL description="Minimal base sandbox environment (no agents)"
LABEL org.opencontainers.image.source=https://github.com/timescale/ox

RUN apt-get update && apt-get install -y --no-install-recommends \
  git \
  curl \
  ca-certificates \
  zip \
  unzip \
  tar \
  gzip \
  jq \
  tmux \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /.ox/signal && chmod 777 /.ox/signal \
  && cat <<'ENTRY' > /.ox/signalEntrypoint.sh && chmod +x /.ox/signalEntrypoint.sh
#!/bin/sh
# wait for ready signal, then start
while [ ! -f /.ox/signal/.ready ]; do
  sleep 0.1
done
exec "$@"
ENTRY

# ============================================================================
# NON-ROOT USER SETUP
# ============================================================================

# Create non-root user (required for claude --dangerously-skip-permissions)
ARG USER_NAME=ox
ARG USER_UID=10000
ARG USER_GID=10000

RUN groupadd --gid ${USER_GID} ${USER_NAME} \
  && useradd --uid ${USER_UID} --gid ${USER_GID} -m ${USER_NAME} \
  && mkdir -p /home/${USER_NAME}/.local/bin \
  && mkdir -p /home/${USER_NAME}/.cache \
  && mkdir -p /home/${USER_NAME}/.config/gh \
  && chown -R ${USER_NAME}:${USER_NAME} /home/${USER_NAME}

# tmux config for agent sessions — mouse support, true-color, ctrl+\ detach
COPY --chown=${USER_UID}:${USER_GID} <<'TMUX_EOF' /home/${USER_NAME}/.tmux.conf
# Detach with ctrl+\ (no prefix needed) — matches Docker detach keys.
bind -n C-\\ detach-client -E true
# Keep default prefix (ctrl+b) for other tmux commands
set -g mouse on
# Hide status bar — ox manages the session, no need for tmux chrome
set -g status off
# True-color support — xterm-256color + Tc flag enables 24-bit RGB
# passthrough so TUI apps (OpenCode, Claude) render correctly
set -g default-terminal "xterm-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
TMUX_EOF

# Switch to non-root user for environment setup
USER ${USER_NAME}

ENV HOME="/home/${USER_NAME}"
ENV PATH="/home/${USER_NAME}/.local/bin:$PATH"
# UTF-8 locale — required for tmux and TUI apps to render Unicode correctly
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
# Prevent Claude Code from auto-updating past the pinned version
ENV DISABLE_AUTOUPDATER=1

RUN  git config --global user.email "ox@tigerdata.com" \
  && git config --global user.name "Ox Agent"

# Create working directory
WORKDIR /work

# Default command
CMD ["/bin/bash"]
