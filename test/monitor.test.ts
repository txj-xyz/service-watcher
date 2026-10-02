import { beforeEach, expect, test } from "bun:test";
import { Notifier } from "../src/alerts/index.ts";
import { parseConfig } from "../src/config.ts";
import { Monitor } from "../src/monitor.ts";
import { Store } from "../src/store.ts";
import type { AlertEvent, CheckResult, MonitorConfig } from "../src/types.ts";

/** Records what each alerter would have received. */
class FakeNotifier extends Notifier {
  sent: { to: string; kind: string }[] = [];
  constructor() {
    super(new Map());
  }
  override async send(to: string, e: AlertEvent) {
    this.sent.push({ to, kind: e.kind });
    return true;
  }
}

let clock = 0;
let next: CheckResult;
let notifier: FakeNotifier;

const ok: CheckResult = { ok: true, latencyMs: 10, message: "ok" };
const slow: CheckResult = { ok: true, degraded: true, latencyMs: 900, message: "slow" };
const fail: CheckResult = { ok: false, latencyMs: 10, message: "boom" };

function make(overrides: Record<string, unknown> = {}) {
  const cfg = parseConfig(
    {
      alerts: { chat: { type: "console" }, pager: { type: "console" } },
      monitors: [{ name: "svc", type: "tcp", host: "x", port: 1, alerts: ["chat", { to: "pager", after: "10m" }], ...overrides }],
    },
    "x.yaml",
  ).monitors[0] as MonitorConfig;
  return new Monitor(cfg, { store: new Store(":memory:"), notifier, check: async () => next, now: () => clock });
}

async function step(m: Monitor, r: CheckResult, advance = 60_000) {
  next = r;
  clock += advance;
  await m.runOnce();
}

beforeEach(() => {
  clock = 1_000_000;
  notifier = new FakeNotifier();
});

test("failure threshold, recovery threshold and recovery goes to notified routes", async () => {
  const m = make({ failureThreshold: 2, recoveryThreshold: 2 });
  await step(m, ok);
  expect(m.status).toBe("up");
  await step(m, fail);
  expect(m.status).toBe("up");
  await step(m, fail);
  expect(m.status).toBe("down");
  expect(notifier.sent).toEqual([{ to: "chat", kind: "down" }]);
  await step(m, ok);
  expect(m.status).toBe("down");
  await step(m, ok);
  expect(m.status).toBe("up");
  expect(notifier.sent.at(-1)).toEqual({ to: "chat", kind: "up" });
});

test("escalates to delayed routes and both get the recovery", async () => {
  const m = make();
  await step(m, fail);
  expect(notifier.sent).toEqual([{ to: "chat", kind: "down" }]);
  for (let i = 0; i < 9; i++) await step(m, fail);
  expect(notifier.sent).toHaveLength(1);
  await step(m, fail); // incident is now 10 minutes old
  expect(notifier.sent).toEqual([{ to: "chat", kind: "down" }, { to: "pager", kind: "down" }]);
  await step(m, fail);
  expect(notifier.sent).toHaveLength(2); // escalation only fires once
  await step(m, ok);
  expect(notifier.sent.slice(2).map((s) => s.to).sort()).toEqual(["chat", "pager"]);
});

test("short outages never reach the escalation route", async () => {
  const m = make();
  await step(m, fail);
  await step(m, ok);
  expect(notifier.sent).toEqual([{ to: "chat", kind: "down" }, { to: "chat", kind: "up" }]);
});

test("reminders while down", async () => {
  const m = make({ renotify: "3m", alerts: ["chat"] });
  await step(m, fail);
  await step(m, fail);
  await step(m, fail);
  expect(notifier.sent).toHaveLength(1);
  await step(m, fail); // 3 minutes since the down alert
  expect(notifier.sent.at(-1)).toEqual({ to: "chat", kind: "reminder" });
});

test("degraded and back", async () => {
  const m = make({ alerts: ["chat"] });
  await step(m, ok);
  await step(m, slow);
  expect(m.status).toBe("degraded");
  await step(m, ok);
  expect(m.status).toBe("up");
  expect(notifier.sent.map((s) => s.kind)).toEqual(["degraded", "up"]);
});

test("notifyOn filters events", async () => {
  const m = make({ alerts: ["chat"], notifyOn: ["down"] });
  await step(m, fail);
  await step(m, ok);
  expect(notifier.sent.map((s) => s.kind)).toEqual(["down"]);
});

test("pending -> up is silent, paused monitors don't check", async () => {
  const m = make();
  await step(m, ok);
  expect(notifier.sent).toHaveLength(0);
  m.pause();
  await step(m, fail);
  expect(m.status).toBe("paused");
  expect(notifier.sent).toHaveLength(0);
});

test("maintenance suppresses checks", async () => {
  const m = make({ maintenance: [{ from: "1970-01-01T00:00:00Z", until: "2100-01-01T00:00:00Z" }] });
  await step(m, fail);
  expect(m.status).toBe("maintenance");
  expect(notifier.sent).toHaveLength(0);
});
