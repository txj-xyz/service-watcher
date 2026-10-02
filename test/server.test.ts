import { afterEach, expect, test } from "bun:test";
import { App } from "../src/app.ts";
import { STARTER_CONFIG, parseConfig, stringifyConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";

let stop: (() => void) | undefined;
afterEach(() => stop?.());

function serve(server: Record<string, unknown>) {
  const raw = { ...STARTER_CONFIG, server: { ...server, port: 0 }, storage: { path: ":memory:" } };
  const app = new App(parseConfig(raw, "/tmp/never-written.yaml"), stringifyConfig(raw));
  const srv = startServer(app);
  stop = () => {
    srv.stop(true);
    app.stop();
  };
  return (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${srv.port}${path}`, init);
}

const write = { method: "POST" };

test("network bind without token is read-only, even when the client claims to be localhost", async () => {
  const req = serve({ host: "0.0.0.0" });
  expect((await req("/api/monitors")).status).toBe(200);
  expect((await req("/api/config", { headers: { host: "localhost" } })).status).toBe(403);
  expect((await req("/api/reload", { ...write, headers: { host: "localhost" } })).status).toBe(403);
});

test("loopback bind without token rejects other Host headers and cross-origin writes", async () => {
  const req = serve({ host: "127.0.0.1" });
  expect((await req("/api/reload", write)).status).toBe(200);
  expect((await req("/api/config", { headers: { host: "evil.example:80" } })).status).toBe(403);
  expect((await req("/api/reload", { ...write, headers: { origin: "https://evil.example" } })).status).toBe(403);
});

test("token protects writes and the raw config", async () => {
  const req = serve({ host: "0.0.0.0", token: "t0k" });
  expect((await req("/api/monitors")).status).toBe(200);
  expect((await req("/api/config")).status).toBe(401);
  expect((await req("/api/config", { headers: { authorization: "Bearer t0k" } })).status).toBe(200);
  expect((await req("/api/reload", { ...write, headers: { authorization: "Bearer nope" } })).status).toBe(401);
});
