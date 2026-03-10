ARG BASE_IMAGE=scratch
FROM ${BASE_IMAGE}

ARG AGENT_NAME
ARG AGENT_VERSION

# Copy install scripts as root
USER root
COPY agents/install-${AGENT_NAME}.sh /tmp/install-agent.sh
COPY agents/install-tiger.sh /tmp/install-tiger.sh
RUN chmod +x /tmp/install-agent.sh /tmp/install-tiger.sh

# Run installs as ox (scripts install to $HOME/.local/bin)
USER ox
RUN bash /tmp/install-agent.sh ${AGENT_VERSION} \
  && bash /tmp/install-tiger.sh

# Clean up temp files (must be root to remove root-owned COPY artifacts)
USER root
RUN rm -f /tmp/install-agent.sh /tmp/install-tiger.sh
USER ox
