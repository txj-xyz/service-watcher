#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { Notifier } from "./alerts/index.ts";
import { App } from "./app.ts";
import { runCheck } from "./checks/index.ts";
import { ConfigError, STARTER_CONFIG, loadConfig, parseConfig, readConfigFile, stringifyConfig } from "./config.ts";
import { configureLog, log } from "./log.ts";
import { startServer, testEvent } from "./server.ts";
import type { AppConfig } from "./types.ts";
import { describeTarget, formatDuration, isLoopback } from "./util.ts";

const HELP = `service-watcher — health checks for HTTP, TCP, UDP, DNS and commands

Usage:
  service-watcher [run]                 Start monitoring + web UI (creates a config if none exists)
  service-watcher check [names...]      Run checks once, print results, exit 1 if any fail
  service-watcher test-alert [names...] Send a test alert to the named alerters (default: all)
  service-watcher validate              Validate the config file and exit
  service-watcher health                Exit 0 if a running instance answers on /health (for Docker)

Options:
  -c, --config <path>   Config file (default: $WATCHER_CONFIG or ./config.yaml)
  -t, --tag <tag>       check: only run monitors with this tag
      --json            check: print JSON instead of a table
      --no-server       run: don't start the dashboard/API server
      --no-watch        run: don't hot-reload the config file
  -h, --help            Show this help

Environment overrides: WATCHER_HOST, WATCHER_PORT, WATCHER_TOKEN, WATCHER_DB, WATCHER_CONFIG
`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    config: { type: "string", short: "c" },
    tag: { type: "string", short: "t" },
    json: { type: "boolean" },
    "no-server": { type: "boolean" },
    "no-watch": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const [command = "run", ...names] = positionals;
const configPath = values.config ?? process.env.WATCHER_CONFIG ?? "config.yaml";

async function load(): Promise<AppConfig> {
  try {
    const cfg = await loadConfig(configPath);
    configureLog(cfg.log);
    return cfg;
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(2);
  }
}

const paint = (code: string, s: string) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);

async function cmdCheck() {
  const cfg = await load();
  let monitors = cfg.monitors.filter((m) => (names.length ? names.includes(m.name) : m.enabled));
  if (values.tag) monitors = monitors.filter((m) => m.tags.includes(values.tag!));
  const unknown = names.filter((n) => !cfg.monitors.some((m) => m.name === n));
  if (unknown.length) {
    console.error(`Unknown monitor(s): ${unknown.join(", ")}`);
    process.exit(2);
  }
  const results = await Promise.all(monitors.map(async (m) => ({ m, r: await runCheck(m) })));
  if (values.json) {
    console.log(JSON.stringify(results.map(({ m, r }) => ({ name: m.name, target: describeTarget(m), ...r })), null, 2));
  } else {
    const width = Math.max(4, ...monitors.map((m) => m.name.length));
    for (const { m, r } of results) {
      const status = !r.ok ? paint("31", "FAIL") : r.degraded ? paint("33", "SLOW") : paint("32", " OK ");
      const latency = `${Math.round(r.latencyMs)}ms`.padStart(7);
      console.log(`${status}  ${m.name.padEnd(width)}  ${latency}  ${paint("90", describeTarget(m))}\n${" ".repeat(width + 17)}${r.message}`);
    }
    const failed = results.filter(({ r }) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passing`);
  }
  process.exit(results.some(({ r }) => !r.ok) ? 1 : 0);
}

async function cmdTestAlert() {
  const cfg = await load();
  const targets = names.length ? names : [...cfg.alerters.keys()];
  if (!targets.length) {
    console.error("No alerters configured under `alerts:`");
    process.exit(2);
  }
  const notifier = new Notifier(cfg.alerters);
  let failed = 0;
  for (const name of targets) {
    const ok = await notifier.send(name, testEvent());
    if (!ok) failed++;
    console.log(`${ok ? paint("32", "sent") : paint("31", "FAILED")}  ${name}`);
  }
  process.exit(failed ? 1 : 0);
}

async function cmdValidate() {
  const cfg = await load();
  console.log(`✓ ${configPath} is valid`);
  console.log(`  ${cfg.monitors.length} monitor(s), ${cfg.alerters.size} alerter(s)`);
  for (const m of cfg.monitors) {
    const routes = m.alerts.map((a) => (a.after ? `${a.to} (after ${formatDuration(a.after)})` : a.to)).join(", ") || "no alerts";
    console.log(`  - ${m.enabled ? "" : "[disabled] "}${m.name}: ${describeTarget(m)} every ${formatDuration(m.interval)} → ${routes}`);
  }
}

async function cmdRun() {
  if (!(await Bun.file(configPath).exists())) {
    await Bun.write(configPath, stringifyConfig(STARTER_CONFIG));
    log.info(`No config found — created ${configPath}. Add monitors and alerts from the dashboard.`);
  }
  let cfg: AppConfig;
  let text: string;
  try {
    const file = await readConfigFile(configPath);
    cfg = parseConfig(file.raw, configPath);
    text = file.text;
    configureLog(cfg.log);
    // Reachable from the network with no token would leave the UI read-only (and edits would be
    // shell access for anyone), so create one and keep it in the config.
    if (cfg.server.enabled && !values["no-server"] && !cfg.server.token && !isLoopback(cfg.server.host)) {
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
      const raw = { ...cfg.raw, server: { ...(cfg.raw.server as object), token } };
      text = stringifyConfig(raw);
      await Bun.write(configPath, text);
      cfg = parseConfig(raw, configPath);
      log.warn(`Listening on ${cfg.server.host} without an access token — generated one and saved it to ${configPath}:`);
      log.warn(`    ${token}`);
      log.warn("Enter it in the web UI to make changes. Set WATCHER_TOKEN to choose your own.");
    }
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(2);
  }
  const app = new App(cfg, text);
  app.start();
  const server = values["no-server"] || !cfg.server.enabled ? undefined : startServer(app);
  if (!values["no-watch"]) app.watchConfig();

  const shutdown = (signal: string) => {
    log.info(`Received ${signal}, shutting down`);
    server?.stop();
    app.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => void app.reload());
}

/** Probes a running instance; used by the Docker HEALTHCHECK. */
async function cmdHealth() {
  let host = process.env.WATCHER_HOST ?? "127.0.0.1";
  let port = Number(process.env.WATCHER_PORT) || 8080;
  try {
    const cfg = await loadConfig(configPath);
    ({ host, port } = cfg.server);
  } catch {}
  if (["0.0.0.0", "::", "[::]"].includes(host)) host = "127.0.0.1";
  try {
    const res = await fetch(`http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}/health`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log("ok");
    process.exit(0);
  } catch (err) {
    console.error(`unhealthy: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

if (values.help) {
  console.log(HELP);
} else {
  switch (command) {
    case "run":
      await cmdRun();
      break;
    case "check":
      await cmdCheck();
      break;
    case "test-alert":
      await cmdTestAlert();
      break;
    case "validate":
      await cmdValidate();
      break;
    case "health":
      await cmdHealth();
      break;
    default:
      console.error(`Unknown command "${command}"\n\n${HELP}`);
      process.exit(2);
  }
}
