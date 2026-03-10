ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG AGENT_NAME
ARG AGENT_VERSION

# Copy install scripts as root, make them executable and writable by ox user
USER root
COPY agents/install-${AGENT_NAME}.sh /tmp/install-agent.sh
COPY agents/install-tiger.sh /tmp/install-tiger.sh
RUN chmod a+rwx /tmp/install-agent.sh /tmp/install-tiger.sh

# Run installs as ox (scripts install to $HOME/.local/bin) and clean up
USER ox
RUN bash /tmp/install-agent.sh ${AGENT_VERSION} \
  && bash /tmp/install-tiger.sh \
  && rm -f /tmp/install-agent.sh /tmp/install-tiger.sh
