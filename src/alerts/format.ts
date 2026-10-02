import type { AlertEvent } from "../types.ts";
import { formatDuration } from "../util.ts";

export const COLORS: Record<AlertEvent["kind"], number> = {
  down: 0xe5484d,
  up: 0x30a46c,
  degraded: 0xf5a524,
  reminder: 0xe5484d,
  test: 0x3e63dd,
};

export const EMOJI: Record<AlertEvent["kind"], string> = {
  down: "🔴",
  up: "🟢",
  degraded: "🟡",
  reminder: "🔴",
  test: "🧪",
};

const ms = (n: number) => (n < 1 ? "<1ms" : `${Math.round(n)}ms`);

export const hexColor = (kind: AlertEvent["kind"]) => `#${COLORS[kind].toString(16).padStart(6, "0")}`;

/** The variables available to `title`, `message` and webhook `body` templates. */
export function templateContext(e: AlertEvent) {
  return {
    ...e,
    emoji: EMOJI[e.kind],
    kindUpper: e.kind.toUpperCase(),
    duration: e.duration !== undefined ? formatDuration(e.duration) : "",
    latency: ms(e.result.latencyMs),
    time: new Date(e.timestamp).toISOString(),
    tags: e.monitor.tags.join(", "),
  };
}

/** Renders "{{monitor.name}}" placeholders. Append "|json" to JSON-encode the value. */
export function render(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*(\|\s*json\s*)?\}\}/g, (_, path: string, json?: string) => {
    let v: unknown = ctx;
    for (const part of path.split(".")) v = v == null ? undefined : (v as Record<string, unknown>)[part];
    if (json) return JSON.stringify(v ?? null);
    return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

export function defaultTitle(e: AlertEvent): string {
  const n = e.monitor.name;
  switch (e.kind) {
    case "down":
      return `${EMOJI.down} ${n} is DOWN`;
    case "up":
      return e.previousStatus === "degraded"
        ? `${EMOJI.up} ${n} is healthy again`
        : `${EMOJI.up} ${n} is back UP${e.duration !== undefined ? ` after ${formatDuration(e.duration)}` : ""}`;
    case "degraded":
      return `${EMOJI.degraded} ${n} is DEGRADED`;
    case "reminder":
      return `${EMOJI.reminder} ${n} is still ${e.status === "degraded" ? "DEGRADED" : "DOWN"}${e.duration !== undefined ? ` (${formatDuration(e.duration)})` : ""}`;
    case "test":
      return `${EMOJI.test} Test alert from service-watcher`;
  }
}

/** Key facts about the event, in display order. */
export function fields(e: AlertEvent): { name: string; value: string; inline: boolean }[] {
  const out = [
    { name: "Target", value: e.monitor.target, inline: false },
    { name: "Type", value: e.monitor.type.toUpperCase(), inline: true },
    { name: "Latency", value: ms(e.result.latencyMs), inline: true },
  ];
  if (e.result.attempts && e.result.attempts > 1) out.push({ name: "Attempts", value: String(e.result.attempts), inline: true });
  if (e.duration !== undefined && e.kind !== "test")
    out.push({ name: e.kind === "up" ? "Downtime" : "Duration", value: formatDuration(e.duration), inline: true });
  if (e.monitor.tags.length) out.push({ name: "Tags", value: e.monitor.tags.join(", "), inline: true });
  return out;
}

export function title(e: AlertEvent, template?: string) {
  return template ? render(template, templateContext(e)) : defaultTitle(e);
}

export function body(e: AlertEvent, template?: string) {
  if (template) return render(template, templateContext(e));
  return e.monitor.description ? `${e.result.message}\n${e.monitor.description}` : e.result.message;
}

/** Plain-text rendering for providers without rich formatting. */
export function plainText(e: AlertEvent, template?: string): string {
  if (template) return render(template, templateContext(e));
  return [body(e), ...fields(e).map((f) => `${f.name}: ${f.value}`)].join("\n");
}

export const isBad = (e: AlertEvent) => e.kind === "down" || e.kind === "reminder";
