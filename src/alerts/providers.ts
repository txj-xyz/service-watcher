import type {
  AlertEvent,
  AlerterConfig,
  CommandAlerterConfig,
  DiscordAlerterConfig,
  GotifyAlerterConfig,
  NtfyAlerterConfig,
  PushoverAlerterConfig,
  SlackAlerterConfig,
  TelegramAlerterConfig,
  WebhookAlerterConfig,
} from "../types.ts";
import { truncate } from "../util.ts";
import { COLORS, body, fields, hexColor, isBad, plainText, render, templateContext, title } from "./format.ts";

export class SendError extends Error {
  constructor(
    message: string,
    public retryAfterMs?: number,
    public retryable = true,
  ) {
    super(message);
  }
}

const REQUEST_TIMEOUT = 15_000;

async function send(url: string, init: RequestInit & { json?: unknown }): Promise<Response> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(url, {
    method: "POST",
    ...rest,
    headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (res.ok) return res;

  const text = await res.text().catch(() => "");
  let retryAfterMs: number | undefined;
  const header = res.headers.get("retry-after");
  if (header) retryAfterMs = Number(header) * 1000;
  try {
    // Discord and Telegram report rate limits in the body.
    const data = JSON.parse(text);
    if (typeof data.retry_after === "number") retryAfterMs = data.retry_after * 1000;
    if (typeof data.parameters?.retry_after === "number") retryAfterMs = data.parameters.retry_after * 1000;
  } catch {}
  const retryable = res.status === 429 || res.status >= 500;
  throw new SendError(`HTTP ${res.status}: ${truncate(text, 300)}`, retryAfterMs, retryable);
}

function discord(cfg: DiscordAlerterConfig, e: AlertEvent) {
  const url = new URL(cfg.url);
  url.searchParams.set("wait", "true");
  if (cfg.threadId) url.searchParams.set("thread_id", cfg.threadId);
  return send(url.toString(), {
    json: {
      username: cfg.username ?? "Service Watcher",
      avatar_url: cfg.avatarUrl,
      content: isBad(e) && cfg.mentions.length ? cfg.mentions.join(" ") : undefined,
      allowed_mentions: { parse: ["users", "roles", "everyone"] },
      embeds: [
        {
          title: truncate(title(e, cfg.title), 256),
          url: e.monitor.type === "http" ? e.monitor.target.split(" ")[1] : undefined,
          description: truncate(body(e, cfg.message), 4000),
          color: COLORS[e.kind],
          fields: fields(e).map((f) => ({ ...f, value: truncate(f.value, 1024) })),
          timestamp: new Date(e.timestamp).toISOString(),
          footer: { text: "service-watcher" },
        },
      ],
    },
  });
}

function slack(cfg: SlackAlerterConfig, e: AlertEvent) {
  const t = title(e, cfg.title);
  const mention = isBad(e) && cfg.mentions.length ? `${cfg.mentions.join(" ")} ` : "";
  return send(cfg.url, {
    json: {
      text: `${mention}${t}`,
      attachments: [
        {
          color: hexColor(e.kind),
          title: t,
          text: body(e, cfg.message),
          fields: fields(e).map((f) => ({ title: f.name, value: f.value, short: f.inline })),
          footer: "service-watcher",
          ts: Math.floor(e.timestamp / 1000),
        },
      ],
    },
  });
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function telegram(cfg: TelegramAlerterConfig, e: AlertEvent) {
  const text = cfg.message
    ? `<b>${escapeHtml(title(e, cfg.title))}</b>\n${escapeHtml(render(cfg.message, templateContext(e)))}`
    : [
        `<b>${escapeHtml(title(e, cfg.title))}</b>`,
        escapeHtml(body(e)),
        "",
        ...fields(e).map((f) => `<b>${f.name}:</b> <code>${escapeHtml(f.value)}</code>`),
      ].join("\n");
  return send(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
    json: {
      chat_id: cfg.chatId,
      message_thread_id: cfg.threadId,
      text: truncate(text, 4096),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      disable_notification: cfg.silentRecovery && e.kind === "up",
    },
  });
}

function ntfy(cfg: NtfyAlerterConfig, e: AlertEvent) {
  const headers: Record<string, string> = {};
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  else if (cfg.username) headers.authorization = `Basic ${btoa(`${cfg.username}:${cfg.password ?? ""}`)}`;
  const tagByKind = { down: "rotating_light", reminder: "rotating_light", up: "white_check_mark", degraded: "warning", test: "test_tube" };
  return send(cfg.server, {
    headers,
    json: {
      topic: cfg.topic,
      title: title(e, cfg.title).replace(/^\p{Extended_Pictographic}\s*/u, ""),
      message: plainText(e, cfg.message),
      priority: isBad(e) ? cfg.priorityDown : e.kind === "degraded" ? Math.max(cfg.priorityUp, 4) : cfg.priorityUp,
      tags: [tagByKind[e.kind], ...e.monitor.tags],
      click: e.monitor.type === "http" ? e.monitor.target.split(" ")[1] : undefined,
    },
  });
}

function gotify(cfg: GotifyAlerterConfig, e: AlertEvent) {
  return send(`${cfg.server}/message`, {
    headers: { "x-gotify-key": cfg.token },
    json: {
      title: title(e, cfg.title),
      message: plainText(e, cfg.message),
      priority: isBad(e) ? cfg.priorityDown : cfg.priorityUp,
    },
  });
}

function pushover(cfg: PushoverAlerterConfig, e: AlertEvent) {
  return send("https://api.pushover.net/1/messages.json", {
    json: {
      token: cfg.token,
      user: cfg.user,
      device: cfg.device,
      sound: cfg.sound,
      title: truncate(title(e, cfg.title), 250),
      message: truncate(plainText(e, cfg.message), 1024),
      priority: isBad(e) ? cfg.priorityDown : cfg.priorityUp,
      timestamp: Math.floor(e.timestamp / 1000),
      url: e.monitor.type === "http" ? e.monitor.target.split(" ")[1] : undefined,
    },
  });
}

function webhook(cfg: WebhookAlerterConfig, e: AlertEvent) {
  const payload = cfg.body
    ? render(cfg.body, templateContext(e))
    : JSON.stringify({ ...e, title: title(e, cfg.title), text: plainText(e, cfg.message) });
  return send(cfg.url, {
    method: cfg.method,
    headers: { "content-type": "application/json", ...cfg.headers },
    body: payload,
  });
}

async function command(cfg: CommandAlerterConfig, e: AlertEvent) {
  const cmd = Array.isArray(cfg.command) ? cfg.command : ["sh", "-c", cfg.command];
  const json = JSON.stringify(e);
  const proc = Bun.spawn(cmd, {
    stdin: new Blob([json]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: cfg.timeout,
    env: {
      ...process.env,
      WATCHER_EVENT: json,
      WATCHER_KIND: e.kind,
      WATCHER_STATUS: e.status,
      WATCHER_MONITOR: e.monitor.name,
      WATCHER_TARGET: e.monitor.target,
      WATCHER_TITLE: title(e, cfg.title),
      WATCHER_MESSAGE: plainText(e, cfg.message),
    },
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new SendError(`command exited with ${code}: ${truncate(stderr.trim(), 300)}`, undefined, false);
}

function consoleAlert(cfg: AlerterConfig, e: AlertEvent) {
  console.log(`\n${"─".repeat(60)}\n${title(e, cfg.title)}\n${plainText(e, cfg.message)}\n${"─".repeat(60)}\n`);
}

export async function deliver(cfg: AlerterConfig, e: AlertEvent): Promise<void> {
  switch (cfg.type) {
    case "discord":
      await discord(cfg, e);
      break;
    case "slack":
      await slack(cfg, e);
      break;
    case "telegram":
      await telegram(cfg, e);
      break;
    case "ntfy":
      await ntfy(cfg, e);
      break;
    case "gotify":
      await gotify(cfg, e);
      break;
    case "pushover":
      await pushover(cfg, e);
      break;
    case "webhook":
      await webhook(cfg, e);
      break;
    case "command":
      await command(cfg, e);
      break;
    case "console":
      consoleAlert(cfg, e);
      break;
  }
}

