import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runCheck } from "../src/checks/index.ts";
import { parseConfig } from "../src/config.ts";
import type { MonitorConfig } from "../src/types.ts";

const monitor = (m: Record<string, unknown>) =>
  parseConfig({ monitors: [{ name: "t", timeout: "2s", ...m }] }, "x.yaml").monitors[0] as MonitorConfig;

let http: ReturnType<typeof Bun.serve>;
let tcp: Bun.TCPSocketListener<undefined>;
let udp: Bun.udp.Socket<"buffer">;
let closedPort: number;

beforeAll(async () => {
  http = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/json") return Response.json({ status: "ok", db: { latency: 3 }, items: [1, 2] });
      if (path === "/slow") return Bun.sleep(300).then(() => new Response("slow"));
      if (path === "/hang") return Bun.sleep(5000).then(() => new Response("late"));
      if (path === "/500") return new Response("err", { status: 500 });
      return new Response("hello world", { headers: { "x-app": "watcher-test" } });
    },
  });
  tcp = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.write("220 ready\r\n");
      },
      data(s, d) {
        if (d.toString().startsWith("PING")) s.write("+PONG\r\n");
      },
    },
  });
  udp = await Bun.udpSocket({
    hostname: "127.0.0.1",
    socket: {
      data(s, buf, port, addr) {
        if (buf.toString() === "ping") s.send("pong", port, addr);
      },
    },
  });
  // Grab a free port, then release it so nothing listens there.
  const tmp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  closedPort = tmp.port;
  tmp.stop(true);
});

afterAll(() => {
  http.stop(true);
  tcp.stop(true);
  udp.close();
});

describe("http", () => {
  const url = (p: string) => `http://localhost:${http.port}${p}`;

  test("passes with body + header checks", async () => {
    const r = await runCheck(monitor({ type: "http", url: url("/"), contains: "hello", expectHeaders: { "x-app": "watcher" } }));
    expect(r).toMatchObject({ ok: true, message: "HTTP 200" });
  });
  test("fails on status", async () => {
    const r = await runCheck(monitor({ type: "http", url: url("/500") }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("HTTP 500");
  });
  test("json assertions", async () => {
    const pass = await runCheck(monitor({ type: "http", url: url("/json"), json: [{ path: "status", equals: "ok" }, { path: "items[1]", equals: 2 }] }));
    expect(pass.ok).toBe(true);
    const failed = await runCheck(monitor({ type: "http", url: url("/json"), json: [{ path: "db.latency", equals: 1 }] }));
    expect(failed.message).toBe("JSON db.latency = 3, expected 1");
  });
  test("forbidden text and regex", async () => {
    expect((await runCheck(monitor({ type: "http", url: url("/"), notContains: "world" }))).ok).toBe(false);
    expect((await runCheck(monitor({ type: "http", url: url("/"), matches: "^hello\\s\\w+$" }))).ok).toBe(true);
  });
  test("degraded when slow", async () => {
    const r = await runCheck(monitor({ type: "http", url: url("/slow"), degradedLatency: "100ms" }));
    expect(r).toMatchObject({ ok: true, degraded: true });
  });
  test("timeout", async () => {
    const r = await runCheck(monitor({ type: "http", url: url("/hang"), timeout: "300ms" }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("timed out");
  });
  test("retries count attempts", async () => {
    const r = await runCheck(monitor({ type: "http", url: url("/500"), retries: 2, retryDelay: "10ms" }));
    expect(r.attempts).toBe(3);
  });
});

describe("tcp", () => {
  test("connects", async () => {
    expect((await runCheck(monitor({ type: "tcp", host: "127.0.0.1", port: tcp.port }))).ok).toBe(true);
  });
  test("reads banner", async () => {
    expect((await runCheck(monitor({ type: "tcp", host: "127.0.0.1", port: tcp.port, expect: "220" }))).ok).toBe(true);
  });
  test("send/expect", async () => {
    const r = await runCheck(monitor({ type: "tcp", host: "127.0.0.1", port: tcp.port, send: "PING\\r\\n", expect: "+PONG" }));
    expect(r.ok).toBe(true);
  });
  test("wrong response times out", async () => {
    const r = await runCheck(monitor({ type: "tcp", host: "127.0.0.1", port: tcp.port, expect: "NOPE", timeout: "300ms" }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('got: "220 ready"');
  });
  test("refused", async () => {
    const r = await runCheck(monitor({ type: "tcp", host: "127.0.0.1", port: closedPort }));
    expect(r.ok).toBe(false);
  });
});

describe("udp", () => {
  test("request/response", async () => {
    const r = await runCheck(monitor({ type: "udp", host: "127.0.0.1", port: udp.port, send: "ping", expect: "pong" }));
    expect(r).toMatchObject({ ok: true });
  });
  test("no response", async () => {
    const r = await runCheck(monitor({ type: "udp", host: "127.0.0.1", port: udp.port, send: "hello", timeout: "300ms" }));
    expect(r.ok).toBe(false);
  });
  test("closed port is detected via ICMP", async () => {
    const r = await runCheck(monitor({ type: "udp", host: "127.0.0.1", port: closedPort, send: "x", expectResponse: false }));
    expect(r.ok).toBe(false);
  });
});

describe("command", () => {
  test("exit code and output", async () => {
    expect((await runCheck(monitor({ type: "command", command: "echo healthy", contains: "healthy" }))).ok).toBe(true);
    const r = await runCheck(monitor({ type: "command", command: ["sh", "-c", "echo bad >&2; exit 3"] }));
    expect(r.message).toBe("Exit code 3 (expected 0): bad");
  });
});
