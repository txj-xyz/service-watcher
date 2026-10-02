import type { CheckResult, HttpMonitorConfig, JsonAssertion } from "../types.ts";
import { errorMessage, truncate } from "../util.ts";
import { certNote } from "./cert.ts";

export function statusMatches(code: number, patterns: string[]): boolean {
  return patterns.some((p) => {
    const s = p.trim().toLowerCase();
    if (/^\dxx$/.test(s)) return Math.floor(code / 100) === Number(s[0]);
    const range = /^(\d{3})\s*-\s*(\d{3})$/.exec(s);
    if (range) return code >= Number(range[1]) && code <= Number(range[2]);
    return Number(s) === code;
  });
}

export function getPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function checkJson(data: unknown, a: JsonAssertion): string | null {
  const value = getPath(data, a.path);
  const shown = truncate(JSON.stringify(value) ?? "undefined", 80);
  if (a.exists !== undefined && (value !== undefined) !== a.exists)
    return `JSON ${a.path} ${a.exists ? "is missing" : `exists (${shown})`}`;
  if (a.equals !== undefined && !Bun.deepEquals(value, a.equals))
    return `JSON ${a.path} = ${shown}, expected ${JSON.stringify(a.equals)}`;
  if (a.matches !== undefined && !new RegExp(a.matches).test(String(value)))
    return `JSON ${a.path} = ${shown}, expected to match /${a.matches}/`;
  return null;
}

export async function checkHttp(m: HttpMonitorConfig): Promise<CheckResult> {
  const started = performance.now();
  let res: Response;
  let body: string;
  try {
    res = await fetch(m.url, {
      method: m.method,
      headers: { "user-agent": "service-watcher/0.1", ...m.headers },
      body: m.body,
      redirect: m.followRedirects ? "follow" : "manual",
      signal: AbortSignal.timeout(m.timeout),
      tls: m.ignoreTls ? { rejectUnauthorized: false } : undefined,
    });
    body = await res.text();
  } catch (err) {
    return { ok: false, latencyMs: performance.now() - started, message: errorMessage(err) };
  }
  const latencyMs = performance.now() - started;
  const details: Record<string, unknown> = { status: res.status, bytes: body.length };
  const fail = (message: string): CheckResult => ({ ok: false, latencyMs, message, details });

  if (!statusMatches(res.status, m.expectStatus))
    return fail(`HTTP ${res.status} ${res.statusText} (expected ${m.expectStatus.join(", ")})`);

  for (const [name, want] of Object.entries(m.expectHeaders)) {
    const got = res.headers.get(name);
    if (got === null || !got.toLowerCase().includes(want.toLowerCase()))
      return fail(`Header ${name}: "${got ?? "missing"}" does not contain "${want}"`);
  }
  for (const needle of m.contains) {
    if (!body.includes(needle)) return fail(`Response body does not contain "${needle}"`);
  }
  for (const needle of m.notContains) {
    if (body.includes(needle)) return fail(`Response body contains forbidden text "${needle}"`);
  }
  if (m.matches && !new RegExp(m.matches).test(body)) return fail(`Response body does not match /${m.matches}/`);

  if (m.json.length) {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      return fail("Response body is not valid JSON");
    }
    for (const a of m.json) {
      const problem = checkJson(data, a);
      if (problem) return fail(problem);
    }
  }

  let message = `HTTP ${res.status}`;
  let degraded = false;
  const url = new URL(m.url);
  if (m.certExpiryDays !== undefined && url.protocol === "https:") {
    try {
      const note = await certNote(url.hostname, Number(url.port) || 443, m.timeout, m.certExpiryDays);
      if (note?.failed) return fail(note.note);
      if (note) {
        degraded = true;
        message += ` — ${note.note}`;
        details.certDaysLeft = note.daysLeft;
      }
    } catch (err) {
      details.certError = errorMessage(err);
    }
  }
  return { ok: true, degraded, latencyMs, message, details };
}
