export type MonitorType = "http" | "tcp" | "udp" | "dns" | "command";
export type Status = "pending" | "up" | "degraded" | "down" | "paused" | "maintenance";
export type EventKind = "down" | "up" | "degraded" | "reminder" | "test";
export type Encoding = "utf8" | "hex" | "base64";

export interface CheckResult {
  ok: boolean;
  /** Check passed but something is off (slow response, cert expiring soon). */
  degraded?: boolean;
  latencyMs: number;
  message: string;
  attempts?: number;
  details?: Record<string, unknown>;
}

/** Either a one-off window (from/until) or a recurring one (days + start/end time). */
export interface MaintenanceWindow {
  from?: number;
  until?: number;
  /** 0 = Sunday ... 6 = Saturday. Empty means every day. */
  days: number[];
  /** Minutes since midnight. */
  start?: number;
  end?: number;
  timezone?: string;
}

export interface AlertRoute {
  /** Name of an alerter defined under `alerts:`. */
  to: string;
  /** Only alert this route once the incident has lasted this long (escalation). */
  after: number;
}

interface BaseMonitorConfig {
  name: string;
  type: MonitorType;
  description?: string;
  enabled: boolean;
  tags: string[];
  interval: number;
  timeout: number;
  /** Extra attempts inside a single check before it counts as failed. */
  retries: number;
  retryDelay: number;
  /** Consecutive failed checks before the monitor is marked down. */
  failureThreshold: number;
  /** Consecutive passing checks before a down monitor is marked up. */
  recoveryThreshold: number;
  /** Latency above this marks the monitor degraded. */
  degradedLatency?: number;
  /** Re-send a reminder every N ms while down/degraded. 0 disables. */
  renotify: number;
  notifyOn: EventKind[];
  alerts: AlertRoute[];
  maintenance: MaintenanceWindow[];
}

export interface JsonAssertion {
  path: string;
  equals?: unknown;
  exists?: boolean;
  matches?: string;
}

export interface HttpMonitorConfig extends BaseMonitorConfig {
  type: "http";
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** e.g. ["2xx", 301, "400-404"] */
  expectStatus: string[];
  contains: string[];
  notContains: string[];
  matches?: string;
  json: JsonAssertion[];
  /** Header name -> substring the header value must contain. */
  expectHeaders: Record<string, string>;
  followRedirects: boolean;
  ignoreTls: boolean;
  /** Mark degraded when the TLS certificate expires within this many days. */
  certExpiryDays?: number;
}

export interface TcpMonitorConfig extends BaseMonitorConfig {
  type: "tcp";
  host: string;
  port: number;
  tls: boolean;
  ignoreTls: boolean;
  send?: string;
  expect?: string;
  encoding: Encoding;
  certExpiryDays?: number;
}

export interface UdpMonitorConfig extends BaseMonitorConfig {
  type: "udp";
  host: string;
  port: number;
  send: string;
  expect?: string;
  encoding: Encoding;
  /** When false the check passes if the packet is sent and no ICMP error comes back. */
  expectResponse: boolean;
}

export interface DnsMonitorConfig extends BaseMonitorConfig {
  type: "dns";
  hostname: string;
  recordType: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SRV" | "PTR" | "SOA" | "CAA";
  /** Resolver IPs, e.g. ["1.1.1.1"]. Empty uses the system resolver. */
  resolvers: string[];
  /** Every value listed must appear in the answer. */
  expect: string[];
}

export interface CommandMonitorConfig extends BaseMonitorConfig {
  type: "command";
  command: string | string[];
  expectExitCode: number;
  contains?: string;
}

export type MonitorConfig =
  | HttpMonitorConfig
  | TcpMonitorConfig
  | UdpMonitorConfig
  | DnsMonitorConfig
  | CommandMonitorConfig;

interface BaseAlerterConfig {
  name: string;
  /** Which event kinds this alerter receives. */
  events: EventKind[];
  /** Optional title/message templates, e.g. "{{emoji}} {{monitor.name}} is {{kindUpper}}". */
  title?: string;
  message?: string;
  retries: number;
}

export interface DiscordAlerterConfig extends BaseAlerterConfig {
  type: "discord";
  url: string;
  username?: string;
  avatarUrl?: string;
  /** e.g. ["<@&123456>", "@here"] — pinged on down/reminder only. */
  mentions: string[];
  threadId?: string;
}

export interface SlackAlerterConfig extends BaseAlerterConfig {
  type: "slack";
  url: string;
  mentions: string[];
}

export interface TelegramAlerterConfig extends BaseAlerterConfig {
  type: "telegram";
  botToken: string;
  chatId: string;
  threadId?: number;
  /** Deliver recovery messages silently. */
  silentRecovery: boolean;
}

export interface NtfyAlerterConfig extends BaseAlerterConfig {
  type: "ntfy";
  server: string;
  topic: string;
  token?: string;
  username?: string;
  password?: string;
  priorityDown: number;
  priorityUp: number;
}

export interface GotifyAlerterConfig extends BaseAlerterConfig {
  type: "gotify";
  server: string;
  token: string;
  priorityDown: number;
  priorityUp: number;
}

export interface PushoverAlerterConfig extends BaseAlerterConfig {
  type: "pushover";
  token: string;
  user: string;
  device?: string;
  sound?: string;
  priorityDown: number;
  priorityUp: number;
}

export interface WebhookAlerterConfig extends BaseAlerterConfig {
  type: "webhook";
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Body template. Defaults to the full event as JSON. Use {{path|json}} for JSON-safe values. */
  body?: string;
}

export interface CommandAlerterConfig extends BaseAlerterConfig {
  type: "command";
  command: string | string[];
  timeout: number;
}

export interface ConsoleAlerterConfig extends BaseAlerterConfig {
  type: "console";
}

export type AlerterConfig =
  | DiscordAlerterConfig
  | SlackAlerterConfig
  | TelegramAlerterConfig
  | NtfyAlerterConfig
  | GotifyAlerterConfig
  | PushoverAlerterConfig
  | WebhookAlerterConfig
  | CommandAlerterConfig
  | ConsoleAlerterConfig;

export interface ServerConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Required for write actions (pause/resume/check) when set. */
  token?: string;
  /** Also require the token for read endpoints and the dashboard. */
  protectReads: boolean;
}

export interface AppConfig {
  path: string;
  server: ServerConfig;
  storage: { path: string; retention: number };
  log: { level: LogLevel; format: "pretty" | "json" };
  monitors: MonitorConfig[];
  alerters: Map<string, AlerterConfig>;
  /** The config as written in the file, before env interpolation and defaults. */
  raw: Record<string, unknown>;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AlertEvent {
  kind: EventKind;
  monitor: {
    name: string;
    type: MonitorType;
    target: string;
    description?: string;
    tags: string[];
  };
  status: Status;
  previousStatus: Status;
  result: CheckResult;
  /** When the current incident began. */
  since?: number;
  /** How long the incident has lasted (reminder) or lasted in total (up). */
  duration?: number;
  timestamp: number;
}
