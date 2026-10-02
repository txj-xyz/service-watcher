import { Notifier } from "./alerts/index.ts";
import { ConflictError, type App } from "./app.ts";
import { runCheck } from "./checks/index.ts";
import { ConfigError, parseConfig } from "./config.ts";
import dashboardHtml from "./dashboard.html" with { type: "text" };
import { log } from "./log.ts";
import type { Monitor } from "./monitor.ts";
import type { AlertEvent } from "./types.ts";
import { ENV_OVERRIDES, isLoopback } from "./util.ts";

// Imported as text so it is embedded in `bun build --compile` binaries.
const dashboard = dashboardHtml as unknown as string;
const DAY = 86_400_000;

function summarize(app: App, m: Monitor, historyLimit: number) {
  const now = Date.now();
  return {
    ...m.snapshot(),
    uptime: {
      "24h": app.store.uptime(m.cfg.name, now - DAY),
      "7d": app.store.uptime(m.cfg.name, now - 7 * DAY),
      "30d": app.store.uptime(m.cfg.name, now - 30 * DAY),
    },
    history: app.store.history(m.cfg.name, historyLimit),
  };
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

function metrics(app: App): string {
  const lines = [
    "# HELP watcher_up 1 if the monitor is up or degraded, 0 if down.",
    "# TYPE watcher_up gauge",
    "# HELP watcher_status Current monitor status (one series per status).",
    "# TYPE watcher_status gauge",
    "# HELP watcher_latency_ms Latency of the last check in milliseconds.",
    "# TYPE watcher_latency_ms gauge",
    "# HELP watcher_uptime_ratio_24h Share of passing checks in the last 24h.",
    "# TYPE watcher_uptime_ratio_24h gauge",
  ];
  const statuses = ["pending", "up", "degraded", "down", "paused", "maintenance"];
  for (const m of app.monitors.values()) {
    const l = `monitor="${esc(m.cfg.name)}",type="${m.cfg.type}"`;
    if (m.status === "up" || m.status === "degraded" || m.status === "down")
      lines.push(`watcher_up{${l}} ${m.status === "down" ? 0 : 1}`);
    for (const s of statuses) lines.push(`watcher_status{${l},status="${s}"} ${m.status === s ? 1 : 0}`);
    if (m.lastResult) lines.push(`watcher_latency_ms{${l}} ${m.lastResult.latencyMs}`);
    const u = app.store.uptime(m.cfg.name, Date.now() - DAY).uptime;
    if (u !== null) lines.push(`watcher_uptime_ratio_24h{${l}} ${(u / 100).toFixed(5)}`);
  }
  return lines.join("\n") + "\n";
}

const hostnameOf = (hostHeader: string | null) => (hostHeader ?? "").replace(/:\d+$/, "").toLowerCase();

async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {}
  throw new ConfigError(["request body must be a JSON object"]);
}

/** Turns thrown errors into JSON responses the UI can show. */
async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConfigError) return Response.json({ error: "Invalid config", problems: err.problems }, { status: 400 });
    if (err instanceof ConflictError) return Response.json({ error: err.message }, { status: 409 });
    log.error(`API error: ${err}`);
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export function startServer(app: App) {
  const { host, port } = app.config.server;
  const loopbackBind = isLoopback(host);
  if (!app.config.server.token && !loopbackBind)
    log.warn(`Server is listening on ${host} without a token — the dashboard is read-only until you set server.token`);

  const tokenOk = (req: Request) => {
    const token = app.config.server.token; // read live so a token set in the UI applies immediately
    const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? new URL(req.url).searchParams.get("token");
    return given === token;
  };

  /**
   * Access rules. The UI can define `command` monitors, so write access is effectively shell access:
   * - with a token: reads are open (unless protectReads), writes need the token
   * - without a token, on a loopback bind: requests must be addressed to localhost (blocks DNS
   *   rebinding) and writes must be same-origin (blocks CSRF from other sites)
   * - without a token, on any other bind: read-only. The Host header can't be trusted there —
   *   any client on the network can claim to be "localhost".
   */
  const check = (req: Request, write: boolean): Response | null => {
    const { token, protectReads } = app.config.server;
    if (write) {
      const origin = req.headers.get("origin");
      if (origin && new URL(origin).host !== req.headers.get("host"))
        return Response.json({ error: "cross-origin request rejected" }, { status: 403 });
    }
    if (token) {
      return (write || protectReads) && !tokenOk(req) ? Response.json({ error: "unauthorized" }, { status: 401 }) : null;
    }
    if (!loopbackBind) {
      return write ? Response.json({ error: "set an access token (server.token or WATCHER_TOKEN) to enable changes" }, { status: 403 }) : null;
    }
    if (!isLoopback(hostnameOf(req.headers.get("host")))) {
      return Response.json({ error: "request must be addressed to localhost" }, { status: 403 });
    }
    return null;
  };

  const read =
    <R extends Request>(fn: (req: R) => Response | Promise<Response>) =>
    (req: R) =>
      check(req, false) ?? fn(req);
  const write =
    <R extends Request>(fn: (req: R) => Promise<Response>) =>
    (req: R) =>
      check(req, true) ?? handle(() => fn(req));

  const find = (name: string) => app.monitors.get(decodeURIComponent(name));
  const notFound = () => Response.json({ error: "monitor not found (it may be disabled)" }, { status: 404 });

  const action = (fn: (m: Monitor) => unknown) =>
    write(async (req: Request & { params: { name: string } }) => {
      const m = find(req.params.name);
      if (!m) return notFound();
      await fn(m);
      return Response.json(summarize(app, m, 60));
    });

  const configResponse = () =>
    Response.json({
      config: app.config.raw,
      version: app.version,
      path: app.config.path,
      fileProblems: app.fileProblems,
      restartRequired: app.restartRequired,
      // Config keys currently overridden by WATCHER_* environment variables.
      envOverrides: Object.entries(ENV_OVERRIDES).filter(([name]) => process.env[name]).map(([name, key]) => ({ name, key })),
    });

  const server = Bun.serve({
    hostname: host,
    port,
    routes: {
      "/": read(() => new Response(dashboard, { headers: { "content-type": "text/html; charset=utf-8" } })),
      "/health": () => Response.json({ ok: true, uptime: Date.now() - app.startedAt }),
      "/metrics": read(() => new Response(metrics(app), { headers: { "content-type": "text/plain; version=0.0.4" } })),
      "/api/monitors": read(() => Response.json([...app.monitors.values()].map((m) => summarize(app, m, 60)))),
      "/api/monitors/:name": read((req) => {
        const m = find(req.params.name);
        return m ? Response.json(summarize(app, m, 500)) : notFound();
      }),
      "/api/monitors/:name/check": { POST: action((m) => m.checkNow()) },
      "/api/monitors/:name/pause": { POST: action((m) => m.pause()) },
      "/api/monitors/:name/resume": { POST: action((m) => m.resume()) },
      "/api/events": read((req) => {
        const url = new URL(req.url);
        const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 1000);
        return Response.json(app.store.events(limit, url.searchParams.get("monitor") ?? undefined));
      }),
      "/api/alerts/:name/test": {
        POST: write(async (req) => {
          const ok = await app.notifier.send(req.params.name, testEvent());
          return Response.json({ ok }, { status: ok ? 200 : 502 });
        }),
      },

      // ── Config editing (raw YAML structure, ${ENV} placeholders kept as-is) ──
      "/api/config": {
        // The raw config contains webhook URLs and tokens, so reading it is treated like a write.
        GET: (req) => check(req, true) ?? configResponse(),
        PUT: write(async (req) => {
          const body = await jsonBody(req);
          await app.saveConfig(body.config, typeof body.version === "string" ? body.version : undefined);
          return configResponse();
        }),
      },
      "/api/config/test-monitor": {
        POST: write(async (req) => {
          const { monitor } = await jsonBody(req);
          const raw = app.config.raw;
          const cfg = parseConfig({ defaults: raw.defaults, alerts: raw.alerts, monitors: [monitor] }, app.config.path);
          return Response.json(await runCheck(cfg.monitors[0]!));
        }),
      },
      "/api/config/test-alert": {
        POST: write(async (req) => {
          const { name, alerter } = await jsonBody(req);
          const key = typeof name === "string" && name ? name : "test";
          const cfg = parseConfig({ alerts: { [key]: alerter }, monitors: [] }, app.config.path);
          const ok = await new Notifier(cfg.alerters).send(key, testEvent());
          return Response.json({ ok, error: ok ? undefined : "Delivery failed — see the watcher log for details" });
        }),
      },
      "/api/reload": { POST: write(async () => (await app.reload(), Response.json({ ok: true }))) },
    },
    fetch: () => Response.json({ error: "not found" }, { status: 404 }),
  });
  log.info(`Dashboard on http://${host === "0.0.0.0" ? "localhost" : host}:${server.port}`);
  return server;
}

export function testEvent(): AlertEvent {
  return {
    kind: "test",
    monitor: { name: "example-monitor", type: "http", target: "GET https://example.com", tags: ["test"] },
    status: "up",
    previousStatus: "up",
    result: { ok: true, latencyMs: 123, message: "This is a test alert. If you can read this, the alerter works." },
    timestamp: Date.now(),
  };
}
