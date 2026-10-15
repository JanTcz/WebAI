# webai agents that run in a container: Pi (https://pi.dev) and OpenCode
# (https://opencode.ai). Run one message at a time via
# `docker compose run --rm agents <cli> …`; sessions live in volumes.
FROM node:26-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

ARG PI_VERSION=1.2.0
ARG OPENCODE_VERSION=1.19.0
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION} \
  && npm install -g opencode-ai@${OPENCODE_VERSION}

WORKDIR /workspace
