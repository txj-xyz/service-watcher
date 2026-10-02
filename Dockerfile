# syntax=docker/dockerfile:1

# ── Build: run the tests, then compile a standalone binary (Bun runtime included) ──
FROM oven/bun:1.4 AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
ARG RUN_TESTS=true
RUN if [ "$RUN_TESTS" = "true" ]; then LOG_LEVEL=error bun test; fi
RUN bun build src/index.ts --compile --sourcemap --outfile /out/service-watcher

# ── Runtime ──
FROM debian:trixie-slim
# ca-certificates: HTTPS checks and webhooks. tzdata: maintenance-window timezones.
# tini: forwards signals and reaps children spawned by `command` monitors/alerters.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --user-group --no-create-home --shell /usr/sbin/nologin watcher \
 && mkdir /data && chown watcher:watcher /data

COPY --from=build /out/service-watcher /usr/local/bin/service-watcher

# Everything persistent lives in /data: config.yaml (created on first start), the
# SQLite history, and an optional .env with secrets for ${VAR} placeholders.
ENV WATCHER_CONFIG=/data/config.yaml \
    WATCHER_DB=/data/watcher.db \
    WATCHER_HOST=0.0.0.0 \
    WATCHER_PORT=8080
WORKDIR /data
VOLUME /data
USER watcher
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["service-watcher", "health"]
ENTRYPOINT ["tini", "--", "service-watcher"]
CMD ["run"]
