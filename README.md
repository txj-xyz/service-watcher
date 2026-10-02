# service-watcher

A health checker for websites, TCP, UDP, DNS and arbitrary commands, built with TypeScript on Bun. It has no runtime dependencies.

- **Checks:** HTTP(S) (status, body text/regex, JSON fields, headers, TLS cert expiry), TCP (connect, TLS, send/expect), UDP (send/expect, ICMP-refused detection), DNS (any record type, custom resolvers, expected values), and shell commands (exit code / output)
- **Controls:** interval, timeout, retries, failure/recovery thresholds, slow-response "degraded" state, reminders while down, delayed escalation routes, maintenance windows (recurring with timezone, or one-off), pause/resume, per-monitor and per-alerter event filters, tags
- **Alerts:** Discord, Slack, Telegram, ntfy, Gotify, Pushover, generic webhook (templated body), shell command (for email, SMS and so on), and console. Delivery is retried and respects `retry_after` rate limits.
- **Ops:** SQLite history with retention, a web dashboard, a JSON API, Prometheus `/metrics`, config hot-reload, and a one-shot `check` mode for cron/CI

## Quick start

```sh
bun install
bun start            # open http://127.0.0.1:8080
```

That's all you need. If `config.yaml` doesn't exist, it's created with sensible defaults. Then you set everything up in the web UI:

- **Monitors:** add, edit, delete, and "Test" a check before saving it
- **Alert channels:** Discord, Slack, Telegram and others, with a "Send test" button
- **Settings:** default timing/alerting for all monitors, global maintenance windows, access token, history retention, logging

Every save is validated, written to `config.yaml`, and applied straight away, with no restart needed. The previous file is kept as `config.yaml.bak`.

You can still edit the YAML by hand (see [`config.example.yaml`](config.example.yaml)). The running app hot-reloads it, and the UI picks up the change. Saving from the UI rewrites the file, so **comments are not kept**. If the file changed on disk after you opened the UI, your save is rejected rather than overwriting the hand edit.

Keep secrets out of the file by typing `${DISCORD_WEBHOOK_URL}` (or `${VAR:-fallback}`) into any field and putting the value in `.env`. Bun loads `.env` automatically. The placeholder is what gets saved.

## Commands

| Command | What it does |
|---|---|
| `bun start` / `service-watcher run` | Monitor continuously and serve the web UI (creates `config.yaml` if missing) |
| `service-watcher check [names…] [-t tag] [--json]` | Run checks once. Exits 1 if any fail, so it works in cron or CI |
| `service-watcher test-alert [alerters…]` | Send a test event to the named alerters (all by default) |
| `service-watcher validate` | Validate the config and print a summary |

Options: `-c/--config <path>` (or `WATCHER_CONFIG`), `--no-server`, `--no-watch`. `SIGHUP` reloads the config. `LOG_LEVEL=debug` logs every check.

`bun run build` compiles a standalone binary to `dist/service-watcher`.

## How alerting works

```
check ──fail──▶ (retries inside the check) ──▶ failureThreshold consecutive fails ──▶ DOWN ──▶ alert routes with no delay
                                                                                         │
                       renotify interval ──▶ "still down" reminder ◀─────────────────────┤
                       route `after: 15m` ──▶ escalation alert once the outage is 15m old ┤
                                                                                         ▼
recoveryThreshold consecutive passes ──▶ UP ──▶ recovery alert to every route that heard about the outage
```

- **Degraded** means the check passed but was slower than `degradedLatency`, or the TLS cert expires within `certExpiryDays`. It alerts separately and counts as up for uptime.
- An outage shorter than an escalation route's `after` never pages that route. Its recovery is not sent there either.
- During a **maintenance window** checks are skipped and no alerts are sent.
- **Pausing** (dashboard or API) persists across restarts.

## Config

[`config.example.yaml`](config.example.yaml) documents every option. A few highlights:

```yaml
alerts:
  discord: { type: discord, url: "${DISCORD_WEBHOOK_URL}", mentions: ["<@&ROLE_ID>"] }
  oncall:  { type: ntfy, topic: my-pager, events: [down, up] }

defaults: { interval: 30s, failureThreshold: 2, renotify: 1h, alerts: [discord] }

monitors:
  - name: api
    type: http
    url: https://api.example.com/health
    json: [{ path: status, equals: ok }]
    degradedLatency: 800ms
    certExpiryDays: 14
    alerts: [discord, { to: oncall, after: 10m }]

  - name: game-server
    type: udp
    host: play.example.com
    port: 27015
    send: "ffffffff54536f7572636520456e67696e6520517565727900"   # Source A2S_INFO
    encoding: hex
```

Custom message templates work on any alerter, for example `title: "{{emoji}} [{{tags}}] {{monitor.name}} {{kindUpper}}"`. For a webhook body, use `{{field|json}}` to insert JSON-escaped values.

## Docker

```sh
docker compose up -d --build
docker compose logs service-watcher    # shows the generated access token on first start
```

Open http://localhost:8080, enter the token, and configure everything in the UI. Or without compose:

```sh
docker build -t service-watcher .
docker run -d --name service-watcher -p 127.0.0.1:8080:8080 -v watcher-data:/data \
  -e WATCHER_TOKEN=change-me --restart unless-stopped service-watcher
```

- **Persistence:** everything lives in the `/data` volume: `config.yaml`, the SQLite history, and an optional `.env` for `${VAR}` secrets. With compose you can also put secrets in a `.env` next to `compose.yaml`.
- **Token:** inside a container the server must listen on `0.0.0.0`. If no token is set, one is generated on first start, saved to `/data/config.yaml` and printed once in the logs. Set `WATCHER_TOKEN` to choose your own.
- **Env overrides:** `WATCHER_HOST`, `WATCHER_PORT`, `WATCHER_TOKEN` and `WATCHER_DB` win over the config file. The image sets host, port and DB path, and the UI shows those settings as locked.
- **Bind mounts:** the container runs as uid 1000. If you bind-mount a host directory instead of using a volume, create it first and make it writable by uid 1000 (`mkdir data && sudo chown 1000:1000 data`), or Docker creates it owned by root and startup fails.
- **Health:** the image has a `HEALTHCHECK` (`service-watcher health`), and `TZ` sets the default timezone for maintenance windows.
- **Extra tools:** the runtime image is a slim Debian with only the compiled binary. If your `command` monitors need tools like `curl`, `ping` or `dig`, extend it:
  ```dockerfile
  FROM service-watcher
  USER root
  RUN apt-get update && apt-get install -y --no-install-recommends curl iputils-ping dnsutils && rm -rf /var/lib/apt/lists/*
  USER watcher
  ```
- **Faster builds:** `--build-arg RUN_TESTS=false` skips the test run during the build.

## Access and security

The UI can create `command` monitors and alerters, which run shell commands, so **edit access is effectively shell access to the host**. The rules:

- **No token (default):** the UI only listens on `127.0.0.1`, and every request must be addressed to `localhost`, which blocks DNS rebinding. Changes must also come from the same origin, which blocks other websites from posting to it (CSRF).
- **Exposing it:** whenever the server listens on anything other than loopback (e.g. `0.0.0.0`, as in Docker) without a token, a random token is generated at startup, saved to the config and printed once in the log. The `Host` header can't be trusted from the network, so a no-token server there would otherwise be read-only. With a token, anyone who can reach the dashboard can view it (unless "Require token to view" is on), and changes need the token. The UI asks for the token and remembers it in the browser.
- **Raw config:** reading it (which includes webhook URLs) needs the same access as editing.

## HTTP API

Send `Authorization: Bearer <token>` (or `?token=`) when a token is set.

| Method | Path | |
|---|---|---|
| GET | `/` | Web UI |
| GET | `/api/monitors` | Running monitors with status, uptime (24h/7d/30d) and recent history |
| GET | `/api/monitors/:name` | One monitor with longer history |
| POST | `/api/monitors/:name/check` | Run a check now |
| POST | `/api/monitors/:name/pause` · `/resume` | Pause / resume (persists across restarts) |
| GET | `/api/events?limit=&monitor=` | Down/up/degraded event log |
| GET | `/api/config` | Raw config (`${ENV}` placeholders intact) and its `version` |
| PUT | `/api/config` | `{ config, version }`. Validates, writes the YAML and applies it. 400 lists problems, 409 means the file changed meanwhile |
| POST | `/api/config/test-monitor` | `{ monitor }`. Runs an unsaved monitor once |
| POST | `/api/config/test-alert` | `{ name, alerter }`. Sends a test via an unsaved channel |
| POST | `/api/alerts/:name/test` | Send a test alert through a saved channel |
| POST | `/api/reload` | Re-read the config file |
| GET | `/metrics` | Prometheus metrics |
| GET | `/health` | Liveness of the watcher itself |

## Notes

- **UDP without a reply** (`expectResponse: false`) can only detect a closed port when the host returns ICMP "port unreachable". Firewalls that silently drop packets will look healthy. Use a protocol-level request and response when you can.
- **Email:** use the `command` alerter with `msmtp`/`sendmail`, or a `webhook` to your mail provider's API. The command receives the event JSON on stdin and in `WATCHER_*` env vars.

## Development

```sh
bun test          # unit + state-machine + real HTTP/TCP/UDP integration tests
bun run typecheck
bun run dev       # restart on source changes
```
