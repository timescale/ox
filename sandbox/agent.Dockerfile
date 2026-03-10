ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG AGENT_NAME
ARG AGENT_VERSION

# Copy install scripts (as root to ensure correct permissions)
USER root
COPY agents/install-${AGENT_NAME}.sh /tmp/install-agent.sh
COPY agents/install-tiger.sh /tmp/install-tiger.sh
RUN chmod +x /tmp/install-agent.sh /tmp/install-tiger.sh
USER ox

# Install agent and tiger CLI, then clean up
RUN bash /tmp/install-agent.sh ${AGENT_VERSION} \
  && bash /tmp/install-tiger.sh \
  && rm -f /tmp/install-agent.sh /tmp/install-tiger.sh
