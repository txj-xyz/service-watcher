import type { CheckResult, MonitorConfig } from "../types.ts";
import { errorMessage } from "../util.ts";
import { checkCommand } from "./command.ts";
import { checkDns } from "./dns.ts";
import { checkHttp } from "./http.ts";
import { checkTcp } from "./tcp.ts";
import { checkUdp } from "./udp.ts";

function dispatch(m: MonitorConfig): Promise<CheckResult> {
  switch (m.type) {
    case "http":
      return checkHttp(m);
    case "tcp":
      return checkTcp(m);
    case "udp":
      return checkUdp(m);
    case "dns":
      return checkDns(m);
    case "command":
      return checkCommand(m);
  }
}

/** Never throws, never hangs much past the monitor's timeout. */
async function guarded(m: MonitorConfig): Promise<CheckResult> {
  const hardLimit = m.timeout + 2_000;
  let timer: Timer | undefined;
  try {
    return await Promise.race([
      dispatch(m),
      new Promise<CheckResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, latencyMs: hardLimit, message: `Check hung for ${hardLimit}ms` }), hardLimit);
      }),
    ]);
  } catch (err) {
    return { ok: false, latencyMs: 0, message: `Check crashed: ${errorMessage(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs a check with retries and applies the degraded-latency rule. */
export async function runCheck(m: MonitorConfig): Promise<CheckResult> {
  let result!: CheckResult;
  let attempt = 0;
  for (; attempt <= m.retries; attempt++) {
    if (attempt > 0) await Bun.sleep(m.retryDelay);
    result = await guarded(m);
    if (result.ok) break;
  }
  result.attempts = Math.min(attempt + 1, m.retries + 1);
  result.latencyMs = Math.round(result.latencyMs * 10) / 10;
  if (result.ok && m.degradedLatency !== undefined && result.latencyMs > m.degradedLatency) {
    result.degraded = true;
    result.message += ` — slow (${Math.round(result.latencyMs)}ms > ${m.degradedLatency}ms)`;
  }
  return result;
}
