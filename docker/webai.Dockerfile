# webai in a container: the CLI and its built-in agent (free models, no key),
# for sites on a machine without Node. Published as ghcr.io/jantcz/webai
# (.github/workflows/release.yml); to build it yourself, from the repository root:
#   docker build -f docker/webai.Dockerfile -t webai .
# A folder of HTML files:
#   docker run --rm -it -p 127.0.0.1:4300:4300 -v "$PWD":/site webai
# A dev server running on the host (the agent edits the mounted project):
#   docker run --rm -it -p 127.0.0.1:4300:4300 -v "$PWD":/site webai --target http://host.docker.internal:3000 --root /site
FROM node:26-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/JanTcz/WebAI" \
      org.opencontainers.image.description="WebAI: click an element on your site, tell an AI agent what to change. CLI with a built-in agent (free models)." \
      org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0"

# git keeps the version history (.webai/history.git); the mounted folder belongs to another user.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'

COPY packages/webai /opt/webai
RUN ln -s /opt/webai/bin/webai.js /usr/local/bin/webai

WORKDIR /site
EXPOSE 4300
# The browser comes in over the Docker network, so the overlay must accept it:
# publish the port on 127.0.0.1 only (see above).
ENTRYPOINT ["webai", "--host", "0.0.0.0", "--allow-remote"]
CMD ["/site"]
