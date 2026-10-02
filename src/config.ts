import { dirname, isAbsolute, resolve } from "node:path";
import type {
  AlertRoute,
  AlerterConfig,
  AppConfig,
  Encoding,
  EventKind,
  LogLevel,
  MaintenanceWindow,
  MonitorConfig,
  MonitorType,
} from "./types.ts";
import { parseDuration } from "./util.ts";

const env = (name: string) => process.env[name] || undefined;

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`Invalid config:\n  - ${problems.join("\n  - ")}`);
  }
}

type Obj = Record<string, unknown>;

const MONITOR_TYPES: MonitorType[] = ["http", "tcp", "udp", "dns", "command"];
const ALERTER_TYPES = ["discord", "slack", "telegram", "ntfy", "gotify", "pushover", "webhook", "command", "console"];
const EVENT_KINDS: EventKind[] = ["down", "up", "degraded", "reminder", "test"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "PTR", "SOA", "CAA"];

/** Collects every problem in the file instead of stopping at the first. */
class Reader {
  problems: string[] = [];

  constructor(private o: Obj, private path: string) {}

  private err(key: string, msg: string) {
    this.problems.push(`${this.path}.${key}: ${msg}`);
  }

  has(key: string) {
    return this.o[key] !== undefined && this.o[key] !== null;
  }

  str(key: string, opts: { required: true; def?: string; oneOf?: readonly string[] }): string;
  str(key: string, opts: { required?: boolean; def: string; oneOf?: readonly string[] }): string;
  str(key: string, opts?: { required?: boolean; def?: string; oneOf?: readonly string[] }): string | undefined;
  str(key: string, opts: { required?: boolean; def?: string; oneOf?: readonly string[] } = {}) {
    const v = this.o[key];
    if (v === undefined || v === null || v === "") {
      if (opts.required && opts.def === undefined) this.err(key, "is required");
      return opts.def ?? (opts.required ? "" : undefined);
    }
    if (typeof v !== "string" && typeof v !== "number") {
      this.err(key, "must be a string");
      return opts.def;
    }
    const s = String(v);
    if (opts.oneOf && !opts.oneOf.includes(s)) {
      this.err(key, `must be one of: ${opts.oneOf.join(", ")} (got "${s}")`);
      return opts.def;
    }
    return s;
  }

  num(key: string, opts: { def: number; min?: number; max?: number; int?: boolean }): number;
  num(key: string, opts?: { def?: number; min?: number; max?: number; int?: boolean; required?: boolean }): number | undefined;
  num(key: string, opts: { def?: number; min?: number; max?: number; int?: boolean; required?: boolean } = {}) {
    const v = this.o[key];
    if (v === undefined || v === null) {
      if (opts.required) this.err(key, "is required");
      return opts.def;
    }
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n)) {
      this.err(key, "must be a number");
      return opts.def;
    }
    if (opts.int && !Number.isInteger(n)) this.err(key, "must be an integer");
    if (opts.min !== undefined && n < opts.min) this.err(key, `must be >= ${opts.min}`);
    if (opts.max !== undefined && n > opts.max) this.err(key, `must be <= ${opts.max}`);
    return n;
  }

  bool(key: string, def: boolean): boolean {
    const v = this.o[key];
    if (v === undefined || v === null) return def;
    if (typeof v === "boolean") return v;
    if (v === "true" || v === "false") return v === "true";
    this.err(key, "must be true or false");
    return def;
  }

  dur(key: string, def: number): number;
  dur(key: string, def?: number): number | undefined;
  dur(key: string, def?: number) {
    const v = this.o[key];
    if (v === undefined || v === null) return def;
    if (v === false || v === 0 || v === "0" || v === "off") return 0;
    const ms = parseDuration(v);
    if (ms === null) {
      this.err(key, `invalid duration "${v}" (use e.g. 500ms, 30s, 5m, 1h30m, 7d)`);
      return def;
    }
    return ms;
  }

  /** Accepts a single string or a list of scalars. */
  strList(key: string, opts: { oneOf?: readonly string[] } = {}): string[] {
    const v = this.o[key];
    if (v === undefined || v === null) return [];
    const list = Array.isArray(v) ? v : [v];
    const out: string[] = [];
    for (const item of list) {
      if (typeof item !== "string" && typeof item !== "number") {
        this.err(key, "must be a string or list of strings");
        continue;
      }
      const s = String(item);
      if (opts.oneOf && !opts.oneOf.includes(s)) {
        this.err(key, `"${s}" is not one of: ${opts.oneOf.join(", ")}`);
        continue;
      }
      out.push(s);
    }
    return out;
  }

  record(key: string): Record<string, string> {
    const v = this.o[key];
    if (v === undefined || v === null) return {};
    if (typeof v !== "object" || Array.isArray(v)) {
      this.err(key, "must be a map of key: value");
      return {};
    }
    return Object.fromEntries(Object.entries(v as Obj).map(([k, val]) => [k, String(val)]));
  }

  list(key: string): unknown[] {
    const v = this.o[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      this.err(key, "must be a list");
      return [];
    }
    return v;
  }

  raw(key: string): unknown {
    return this.o[key];
  }
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Replaces ${VAR} and ${VAR:-default} in every string value. */
function interpolateEnv(value: unknown, missing: Set<string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, def?: string) => {
      const v = process.env[name];
      if (v !== undefined && v !== "") return v;
      if (def !== undefined) return def;
      missing.add(name);
      return "";
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, missing));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, missing)]));
  return value;
}

function parseClock(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

function parseMaintenance(items: unknown[], path: string, problems: string[]): MaintenanceWindow[] {
  const out: MaintenanceWindow[] = [];
  items.forEach((item, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(item)) {
      problems.push(`${p}: must be an object`);
      return;
    }
    const r = new Reader(item, p);
    const w: MaintenanceWindow = { days: [], timezone: r.str("timezone") };
    if (r.has("from") || r.has("until")) {
      const from = Date.parse(r.str("from", { required: true }));
      const until = Date.parse(r.str("until", { required: true }));
      if (Number.isNaN(from) || Number.isNaN(until)) problems.push(`${p}: from/until must be ISO dates, e.g. 2026-10-05T02:00:00Z`);
      w.from = from;
      w.until = until;
    } else {
      const start = parseClock(r.str("start", { required: true }));
      const end = parseClock(r.str("end", { required: true }));
      if (start === null || end === null) problems.push(`${p}: start/end must be HH:MM`);
      w.start = start ?? 0;
      w.end = end ?? 0;
      for (const d of r.strList("days")) {
        const idx = DAYS.indexOf(d.toLowerCase().slice(0, 3));
        if (idx === -1) problems.push(`${p}.days: unknown day "${d}"`);
        else w.days.push(idx);
      }
    }
    if (w.timezone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: w.timezone });
      } catch {
        problems.push(`${p}.timezone: unknown timezone "${w.timezone}"`);
      }
    }
    problems.push(...r.problems);
    out.push(w);
  });
  return out;
}

function parseRoutes(items: unknown[], path: string, problems: string[]): AlertRoute[] {
  return items.flatMap((item, i): AlertRoute[] => {
    if (typeof item === "string") return [{ to: item, after: 0 }];
    if (!isObj(item)) {
      problems.push(`${path}[${i}]: must be an alerter name or { to, after }`);
      return [];
    }
    const r = new Reader(item, `${path}[${i}]`);
    const route = { to: r.str("to", { required: true }), after: r.dur("after", 0) };
    problems.push(...r.problems);
    return [route];
  });
}

function parseMonitor(raw: Obj, defaults: Obj, index: number, problems: string[]): MonitorConfig | null {
  const label = typeof raw.name === "string" ? raw.name : `#${index}`;
  const merged: Obj = { ...defaults, ...raw };
  const r = new Reader(merged, `monitors[${label}]`);
  const type = r.str("type", { required: true, oneOf: MONITOR_TYPES }) as MonitorType;

  const base = {
    name: r.str("name", { required: true }),
    description: r.str("description"),
    enabled: r.bool("enabled", true),
    tags: r.strList("tags"),
    interval: r.dur("interval", 60_000),
    timeout: r.dur("timeout", 10_000),
    retries: r.num("retries", { def: 0, min: 0, max: 10, int: true }),
    retryDelay: r.dur("retryDelay", 2_000),
    failureThreshold: r.num("failureThreshold", { def: 1, min: 1, int: true }),
    recoveryThreshold: r.num("recoveryThreshold", { def: 1, min: 1, int: true }),
    degradedLatency: r.dur("degradedLatency"),
    renotify: r.dur("renotify", 0),
    notifyOn: r.has("notifyOn")
      ? (r.strList("notifyOn", { oneOf: EVENT_KINDS }) as EventKind[])
      : (["down", "up", "degraded", "reminder"] as EventKind[]),
    alerts: parseRoutes(r.list("alerts"), `monitors[${label}].alerts`, problems),
    // Global maintenance windows apply in addition to the monitor's own.
    maintenance: parseMaintenance(
      [
        ...(Array.isArray(defaults.maintenance) ? defaults.maintenance : []),
        ...(Array.isArray(raw.maintenance) ? raw.maintenance : []),
      ],
      `monitors[${label}].maintenance`,
      problems,
    ),
  };
  if (base.interval < 1000) problems.push(`monitors[${label}].interval: must be at least 1s`);

  let monitor: MonitorConfig | null = null;
  const encoding = () => r.str("encoding", { def: "utf8", oneOf: ["utf8", "hex", "base64"] }) as Encoding;

  switch (type) {
    case "http": {
      const url = r.str("url", { required: true });
      try {
        const u = new URL(url);
        if (!["http:", "https:"].includes(u.protocol)) problems.push(`monitors[${label}].url: must be http(s)`);
      } catch {
        problems.push(`monitors[${label}].url: invalid URL "${url}"`);
      }
      const matches = r.str("matches");
      if (matches) {
        try {
          new RegExp(matches);
        } catch {
          problems.push(`monitors[${label}].matches: invalid regex`);
        }
      }
      const json = r.list("json").flatMap((a, i) => {
        if (!isObj(a) || typeof a.path !== "string") {
          problems.push(`monitors[${label}].json[${i}]: needs a "path"`);
          return [];
        }
        return [{ path: a.path, equals: a.equals, exists: a.exists as boolean | undefined, matches: a.matches as string | undefined }];
      });
      const rawBody = r.raw("body");
      monitor = {
        ...base,
        type,
        url,
        method: r.str("method", { def: "GET" }).toUpperCase(),
        headers: r.record("headers"),
        body: isObj(rawBody) || Array.isArray(rawBody) ? JSON.stringify(rawBody) : r.str("body"),
        expectStatus: r.has("expectStatus") ? r.strList("expectStatus") : ["2xx", "3xx"],
        contains: r.strList("contains"),
        notContains: r.strList("notContains"),
        matches,
        json,
        expectHeaders: r.record("expectHeaders"),
        followRedirects: r.bool("followRedirects", true),
        ignoreTls: r.bool("ignoreTls", false),
        certExpiryDays: r.num("certExpiryDays", { min: 0 }),
      };
      break;
    }
    case "tcp":
      monitor = {
        ...base,
        type,
        host: r.str("host", { required: true }),
        port: r.num("port", { required: true, min: 1, max: 65535, int: true }) ?? 0,
        tls: r.bool("tls", false),
        ignoreTls: r.bool("ignoreTls", false),
        send: r.str("send"),
        expect: r.str("expect"),
        encoding: encoding(),
        certExpiryDays: r.num("certExpiryDays", { min: 0 }),
      };
      break;
    case "udp":
      monitor = {
        ...base,
        type,
        host: r.str("host", { required: true }),
        port: r.num("port", { required: true, min: 1, max: 65535, int: true }) ?? 0,
        send: r.str("send", { required: true }),
        expect: r.str("expect"),
        encoding: encoding(),
        expectResponse: r.bool("expectResponse", true),
      };
      break;
    case "dns":
      monitor = {
        ...base,
        type,
        hostname: r.str("hostname", { required: true }),
        recordType: r.str("recordType", { def: "A", oneOf: RECORD_TYPES }) as "A",
        resolvers: r.strList("resolvers"),
        expect: r.strList("expect"),
      };
      break;
    case "command": {
      const cmd = r.raw("command");
      if (!(typeof cmd === "string" || (Array.isArray(cmd) && cmd.length && cmd.every((c) => typeof c === "string"))))
        problems.push(`monitors[${label}].command: must be a string or list of strings`);
      monitor = {
        ...base,
        type,
        command: cmd as string | string[],
        expectExitCode: r.num("expectExitCode", { def: 0, int: true }),
        contains: r.str("contains"),
      };
      break;
    }
  }
  problems.push(...r.problems);
  return monitor;
}

function parseAlerter(name: string, raw: Obj, problems: string[]): AlerterConfig | null {
  const r = new Reader(raw, `alerts.${name}`);
  const type = r.str("type", { required: true, oneOf: ALERTER_TYPES });
  const base = {
    name,
    events: r.has("events")
      ? (r.strList("events", { oneOf: EVENT_KINDS }) as EventKind[])
      : (["down", "up", "degraded", "reminder", "test"] as EventKind[]),
    title: r.str("title"),
    message: r.str("message"),
    retries: r.num("retries", { def: 2, min: 0, max: 10, int: true }),
  };
  if (base.events.length && !base.events.includes("test")) base.events.push("test");
  let cfg: AlerterConfig | null = null;
  switch (type) {
    case "discord":
      cfg = {
        ...base,
        type,
        url: r.str("url", { required: true }),
        username: r.str("username"),
        avatarUrl: r.str("avatarUrl"),
        mentions: r.strList("mentions"),
        threadId: r.str("threadId"),
      };
      break;
    case "slack":
      cfg = { ...base, type, url: r.str("url", { required: true }), mentions: r.strList("mentions") };
      break;
    case "telegram":
      cfg = {
        ...base,
        type,
        botToken: r.str("botToken", { required: true }),
        chatId: r.str("chatId", { required: true }),
        threadId: r.num("threadId", { int: true }),
        silentRecovery: r.bool("silentRecovery", false),
      };
      break;
    case "ntfy":
      cfg = {
        ...base,
        type,
        server: r.str("server", { def: "https://ntfy.sh" }).replace(/\/+$/, ""),
        topic: r.str("topic", { required: true }),
        token: r.str("token"),
        username: r.str("username"),
        password: r.str("password"),
        priorityDown: r.num("priorityDown", { def: 5, min: 1, max: 5, int: true }),
        priorityUp: r.num("priorityUp", { def: 3, min: 1, max: 5, int: true }),
      };
      break;
    case "gotify":
      cfg = {
        ...base,
        type,
        server: r.str("server", { required: true }).replace(/\/+$/, ""),
        token: r.str("token", { required: true }),
        priorityDown: r.num("priorityDown", { def: 8, min: 0, max: 10, int: true }),
        priorityUp: r.num("priorityUp", { def: 4, min: 0, max: 10, int: true }),
      };
      break;
    case "pushover":
      cfg = {
        ...base,
        type,
        token: r.str("token", { required: true }),
        user: r.str("user", { required: true }),
        device: r.str("device"),
        sound: r.str("sound"),
        priorityDown: r.num("priorityDown", { def: 1, min: -2, max: 2, int: true }),
        priorityUp: r.num("priorityUp", { def: 0, min: -2, max: 2, int: true }),
      };
      break;
    case "webhook":
      cfg = {
        ...base,
        type,
        url: r.str("url", { required: true }),
        method: r.str("method", { def: "POST" }).toUpperCase(),
        headers: r.record("headers"),
        body: r.str("body"),
      };
      break;
    case "command":
      cfg = {
        ...base,
        type,
        command: r.raw("command") as string | string[],
        timeout: r.dur("timeout", 15_000),
      };
      if (!cfg.command) problems.push(`alerts.${name}.command: is required`);
      break;
    case "console":
      cfg = { ...base, type };
      break;
  }
  problems.push(...r.problems);
  return cfg;
}

export function parseConfig(input: unknown, configPath: string): AppConfig {
  const problems: string[] = [];
  const missing = new Set<string>();
  const root = interpolateEnv(input ?? {}, missing);
  if (!isObj(root)) throw new ConfigError(["config root must be a map"]);
  for (const name of missing) problems.push(`environment variable \${${name}} is not set`);

  const baseDir = dirname(resolve(configPath));
  const at = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));

  const sr = new Reader(isObj(root.server) ? root.server : {}, "server");
  const server = {
    enabled: sr.bool("enabled", true),
    host: sr.str("host", { def: "127.0.0.1" }),
    port: sr.num("port", { def: 8080, min: 0, max: 65535, int: true }),
    token: sr.str("token"),
    protectReads: sr.bool("protectReads", false),
  };
  // WATCHER_* environment variables win over the file (see ENV_OVERRIDES).
  if (env("WATCHER_HOST")) server.host = env("WATCHER_HOST")!;
  if (env("WATCHER_TOKEN")) server.token = env("WATCHER_TOKEN");
  if (env("WATCHER_PORT")) {
    const port = Number(env("WATCHER_PORT"));
    if (!Number.isInteger(port) || port < 0 || port > 65535) problems.push(`WATCHER_PORT: invalid port "${env("WATCHER_PORT")}"`);
    else server.port = port;
  }
  const st = new Reader(isObj(root.storage) ? root.storage : {}, "storage");
  const storage = { path: at(env("WATCHER_DB") ?? st.str("path", { def: "./data/watcher.db" })), retention: st.dur("retention", 30 * 86_400_000) };
  const lr = new Reader(isObj(root.log) ? root.log : {}, "log");
  const logCfg = {
    level: lr.str("level", { def: "info", oneOf: ["debug", "info", "warn", "error"] }) as LogLevel,
    format: lr.str("format", { def: "pretty", oneOf: ["pretty", "json"] }) as "pretty" | "json",
  };
  problems.push(...sr.problems, ...st.problems, ...lr.problems);

  const alerters = new Map<string, AlerterConfig>();
  if (root.alerts !== undefined && !isObj(root.alerts)) problems.push("alerts: must be a map of name -> alerter");
  for (const [name, raw] of Object.entries(isObj(root.alerts) ? root.alerts : {})) {
    if (!isObj(raw)) {
      problems.push(`alerts.${name}: must be an object`);
      continue;
    }
    const a = parseAlerter(name, raw, problems);
    if (a) alerters.set(name, a);
  }

  const defaults = isObj(root.defaults) ? root.defaults : {};
  if (!Array.isArray(root.monitors)) problems.push("monitors: must be a list");
  const monitors: MonitorConfig[] = [];
  const seen = new Set<string>();
  (Array.isArray(root.monitors) ? root.monitors : []).forEach((raw, i) => {
    if (!isObj(raw)) {
      problems.push(`monitors[${i}]: must be an object`);
      return;
    }
    if (typeof raw.name === "string") {
      if (seen.has(raw.name)) problems.push(`monitors[${raw.name}]: duplicate name`);
      seen.add(raw.name);
    }
    const m = parseMonitor(raw, defaults, i, problems);
    if (!m) return;
    for (const route of m.alerts) {
      if (!alerters.has(route.to)) problems.push(`monitors[${m.name}].alerts: unknown alerter "${route.to}"`);
    }
    monitors.push(m);
  });

  if (problems.length) throw new ConfigError(problems);
  return { path: resolve(configPath), server, storage, log: logCfg, monitors, alerters, raw: input as Obj };
}

/** Written when the app starts without a config file; everything else is added from the web UI. */
export const STARTER_CONFIG = {
  server: { host: "127.0.0.1", port: 8080 },
  storage: { path: "./data/watcher.db", retention: "30d" },
  log: { level: "info", format: "pretty" },
  defaults: { interval: "60s", timeout: "10s", retries: 1, failureThreshold: 2, recoveryThreshold: 1, renotify: "30m" },
  alerts: {},
  monitors: [],
};

export function stringifyConfig(raw: unknown): string {
  const yaml = Bun.YAML.stringify(raw, null, 2).replace(/[ \t]+$/gm, "");
  return `# service-watcher config — edit here or in the web UI (saving from the UI rewrites this file).\n${yaml}\n`;
}

export async function readConfigFile(path: string): Promise<{ raw: unknown; text: string }> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new ConfigError([`config file not found: ${path} (copy config.example.yaml to get started)`]);
  const text = await file.text();
  try {
    return { raw: path.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text), text };
  } catch (err) {
    throw new ConfigError([`could not parse ${path}: ${(err as Error).message}`]);
  }
}

export async function loadConfig(path: string): Promise<AppConfig> {
  return parseConfig((await readConfigFile(path)).raw, path);
}
