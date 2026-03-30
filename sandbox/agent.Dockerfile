ARG BASE_IMAGE=scratch
FROM ${BASE_IMAGE}

ARG AGENT_NAME
ARG AGENT_VERSION

USER root
COPY agents/install-${AGENT_NAME}.sh /tmp/install-agent.sh
RUN chmod +x /tmp/install-agent.sh

USER ox
RUN bash /tmp/install-agent.sh ${AGENT_VERSION}

USER root
RUN rm -f /tmp/install-agent.sh
USER ox
