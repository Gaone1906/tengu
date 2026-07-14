FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates chromium git g++ lsof make procps python3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /workspace
COPY docker-entrypoint.sh /usr/local/bin/jinn-upgrade-lab
RUN chmod 0755 /usr/local/bin/jinn-upgrade-lab
ENTRYPOINT ["/usr/local/bin/jinn-upgrade-lab"]
