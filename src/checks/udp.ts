import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { CheckResult, UdpMonitorConfig } from "../types.ts";
import { decodePayload, errorMessage, truncate } from "../util.ts";

/** How long to wait for an ICMP "port unreachable" when no reply is expected. */
const NO_REPLY_GRACE_MS = 1500;

export async function checkUdp(m: UdpMonitorConfig): Promise<CheckResult> {
  const started = performance.now();
  let address = m.host;
  try {
    if (!isIP(m.host)) address = (await lookup(m.host)).address;
  } catch (err) {
    return { ok: false, latencyMs: performance.now() - started, message: `DNS lookup failed: ${errorMessage(err)}` };
  }
  const payload = decodePayload(m.send, m.encoding);
  const expect = m.expect ? decodePayload(m.expect, m.encoding) : null;

  return new Promise((resolve) => {
    let done = false;
    let socket: { close(): void } | undefined;

    const finish = (ok: boolean, message: string, details?: Record<string, unknown>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {}
      resolve({ ok, latencyMs: performance.now() - started, message, details: { address, ...details } });
    };

    const timer = setTimeout(
      () =>
        m.expectResponse
          ? finish(false, `No response within ${m.timeout}ms`)
          : finish(true, "Packet sent, no ICMP error (no response expected)"),
      m.expectResponse ? m.timeout : Math.min(m.timeout, NO_REPLY_GRACE_MS),
    );

    Bun.udpSocket({
      connect: { hostname: address, port: m.port },
      socket: {
        data(_s, data) {
          const buf = Buffer.from(data);
          if (!expect || buf.indexOf(expect) !== -1) {
            finish(true, `Response received (${buf.length} bytes)`, { bytesReceived: buf.length });
          } else {
            finish(false, `Unexpected response: "${truncate(buf.toString("utf8").trim(), 60)}"`, { bytesReceived: buf.length });
          }
        },
        error(_s, err) {
          // Connected UDP sockets surface ICMP port-unreachable as ECONNREFUSED.
          finish(false, errorMessage(err));
        },
      },
    }).then(
      (s) => {
        socket = s;
        if (done) return s.close();
        try {
          s.send(payload);
        } catch (err) {
          finish(false, `Send failed: ${errorMessage(err)}`);
        }
      },
      (err) => finish(false, `Socket error: ${errorMessage(err)}`),
    );
  });
}
