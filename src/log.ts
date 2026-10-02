import type { LogLevel } from "./types.ts";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS: Record<LogLevel, string> = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };
const RESET = "\x1b[0m";

let level: LogLevel = (process.env.LOG_LEVEL as LogLevel) in ORDER ? (process.env.LOG_LEVEL as LogLevel) : "info";
let format: "pretty" | "json" = "pretty";
const color = process.stdout.isTTY && !process.env.NO_COLOR;

export function configureLog(opts: { level?: LogLevel; format?: "pretty" | "json" }) {
  if (opts.level && !process.env.LOG_LEVEL) level = opts.level;
  if (opts.format) format = opts.format;
}

function write(lvl: LogLevel, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[lvl] < ORDER[level]) return;
  const out = lvl === "error" || lvl === "warn" ? console.error : console.log;
  if (format === "json") {
    out(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...fields }));
    return;
  }
  const time = new Date().toISOString().slice(11, 19);
  const tag = color ? `${COLORS[lvl]}${lvl.toUpperCase().padEnd(5)}${RESET}` : lvl.toUpperCase().padEnd(5);
  const extra = fields
    ? " " + Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")
    : "";
  out(`${time} ${tag} ${msg}${color && extra ? `\x1b[90m${extra}${RESET}` : extra}`);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
