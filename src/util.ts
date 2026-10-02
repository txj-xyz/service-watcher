import type { Encoding, MonitorConfig } from "./types.ts";

const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Parses "500ms", "30s", "5m", "1h30m", "7d" or a plain number of milliseconds. */
export function parseDuration(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*/y;
  let total = 0;
  let pos = 0;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) return null;
    total += Number(m[1]) * UNITS[m[2]!]!;
    pos = re.lastIndex;
  }
  return pos > 0 ? total : null;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  let secs = Math.round(ms / 1000);
  const parts: string[] = [];
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
    if (secs >= size) {
      parts.push(`${Math.floor(secs / size)}${unit}`);
      secs %= size;
    }
  }
  return parts.slice(0, 2).join(" ");
}

export function decodePayload(data: string, encoding: Encoding): Buffer {
  if (encoding === "hex") return Buffer.from(data.replace(/[\s:]/g, ""), "hex");
  if (encoding === "base64") return Buffer.from(data, "base64");
  return Buffer.from(data.replace(/\\r/g, "\r").replace(/\\n/g, "\n"), "utf8");
}

export function describeTarget(m: MonitorConfig): string {
  switch (m.type) {
    case "http":
      return `${m.method} ${m.url}`;
    case "tcp":
      return `${m.tls ? "tls" : "tcp"}://${m.host}:${m.port}`;
    case "udp":
      return `udp://${m.host}:${m.port}`;
    case "dns":
      return `${m.recordType} ${m.hostname}${m.resolvers.length ? ` @${m.resolvers.join(",")}` : ""}`;
    case "command":
      return Array.isArray(m.command) ? m.command.join(" ") : m.command;
  }
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
export const isLoopback = (host: string) => LOOPBACK_HOSTS.includes(host.toLowerCase());

/** Environment variables that override config values (handy in containers). */
export const ENV_OVERRIDES = {
  WATCHER_HOST: "server.host",
  WATCHER_PORT: "server.port",
  WATCHER_TOKEN: "server.token",
  WATCHER_DB: "storage.path",
} as const;

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (err.name === "TimeoutError") return "Request timed out";
    return code && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
