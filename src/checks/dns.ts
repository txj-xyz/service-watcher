import { Resolver } from "node:dns/promises";
import type { CheckResult, DnsMonitorConfig } from "../types.ts";
import { errorMessage, truncate } from "../util.ts";

function normalize(type: DnsMonitorConfig["recordType"], answer: unknown): string[] {
  const list = Array.isArray(answer) ? answer : [answer];
  return list.map((r: any) => {
    switch (type) {
      case "MX":
        return `${r.priority} ${r.exchange}`;
      case "TXT":
        return Array.isArray(r) ? r.join("") : String(r);
      case "SRV":
        return `${r.priority} ${r.weight} ${r.port} ${r.name}`;
      case "SOA":
        return `${r.nsname} ${r.hostmaster} ${r.serial}`;
      case "CAA":
        return `${r.critical} ${Object.keys(r).find((k) => k !== "critical")} ${Object.values(r).at(-1)}`;
      default:
        return String(r);
    }
  });
}

export async function checkDns(m: DnsMonitorConfig): Promise<CheckResult> {
  const started = performance.now();
  const resolver = new Resolver({ timeout: m.timeout, tries: 1 });
  if (m.resolvers.length) resolver.setServers(m.resolvers);

  let records: string[];
  try {
    const answer = await Promise.race([
      resolver.resolve(m.hostname, m.recordType),
      Bun.sleep(m.timeout).then(() => {
        throw new Error(`DNS query timed out after ${m.timeout}ms`);
      }),
    ]);
    records = normalize(m.recordType, answer);
  } catch (err) {
    resolver.cancel();
    return { ok: false, latencyMs: performance.now() - started, message: errorMessage(err) };
  }
  const latencyMs = performance.now() - started;
  const details = { records };

  if (!records.length) return { ok: false, latencyMs, message: `No ${m.recordType} records`, details };
  const lower = records.map((r) => r.toLowerCase().replace(/\.$/, ""));
  for (const want of m.expect) {
    const w = want.toLowerCase().replace(/\.$/, "");
    if (!lower.some((r) => r === w || r.includes(w)))
      return { ok: false, latencyMs, message: `Expected "${want}" not in answer: ${truncate(records.join(", "), 120)}`, details };
  }
  return { ok: true, latencyMs, message: truncate(`${m.recordType}: ${records.join(", ")}`, 200), details };
}
