import type { Socket } from "bun";
import type { CheckResult, TcpMonitorConfig } from "../types.ts";
import { decodePayload, errorMessage, truncate } from "../util.ts";
import { certNote } from "./cert.ts";

function connect(m: TcpMonitorConfig): Promise<CheckResult> {
  const started = performance.now();
  const expect = m.expect ? decodePayload(m.expect, m.encoding) : null;

  return new Promise((resolve) => {
    let done = false;
    let sock: Socket | undefined;
    let received = Buffer.alloc(0);

    const finish = (ok: boolean, message: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock?.end();
      } catch {}
      resolve({ ok, latencyMs: performance.now() - started, message, details: { bytesReceived: received.length } });
    };
    const timer = setTimeout(() => {
      const got = received.length ? ` (got: "${truncate(received.toString("utf8").trim(), 60)}")` : "";
      finish(false, `${expect ? "Expected response not received" : "Connection timed out"} after ${m.timeout}ms${got}`);
    }, m.timeout);

    // Runs once the connection (and TLS handshake, if any) is established.
    const ready = (s: Socket) => {
      if (m.send) s.write(decodePayload(m.send, m.encoding));
      if (!expect) finish(true, m.tls ? "TLS handshake OK" : "Connected");
    };

    Bun.connect({
      hostname: m.host,
      port: m.port,
      tls: m.tls ? { serverName: m.host, rejectUnauthorized: !m.ignoreTls } : undefined,
      socket: {
        open(s) {
          sock = s;
          if (!m.tls) ready(s);
        },
        handshake(s, success, authError) {
          if (authError && !m.ignoreTls) return finish(false, `TLS error: ${authError.message}`);
          if (!success && !m.ignoreTls) return finish(false, "TLS handshake failed");
          ready(s);
        },
        data(_s, chunk) {
          received = Buffer.concat([received, chunk]);
          if (expect && received.indexOf(expect) !== -1) finish(true, `Received expected response`);
        },
        close() {
          finish(false, expect ? "Connection closed before expected response" : "Connection closed by peer");
        },
        error(_s, err) {
          finish(false, errorMessage(err));
        },
        connectError(_s, err) {
          finish(false, `Connect failed: ${errorMessage(err)}`);
        },
      },
    }).then(
      (s) => {
        sock = s;
        if (done) s.end();
      },
      (err) => finish(false, `Connect failed: ${errorMessage(err)}`),
    );
  });
}

export async function checkTcp(m: TcpMonitorConfig): Promise<CheckResult> {
  const result = await connect(m);
  if (!result.ok || !m.tls || m.certExpiryDays === undefined) return result;
  try {
    const note = await certNote(m.host, m.port, m.timeout, m.certExpiryDays);
    if (note?.failed) return { ...result, ok: false, message: note.note };
    if (note) return { ...result, degraded: true, message: `${result.message} — ${note.note}` };
  } catch (err) {
    result.details = { ...result.details, certError: errorMessage(err) };
  }
  return result;
}
