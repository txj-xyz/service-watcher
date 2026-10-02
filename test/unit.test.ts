import { describe, expect, test } from "bun:test";
import { render } from "../src/alerts/format.ts";
import { statusMatches, getPath } from "../src/checks/http.ts";
import { ConfigError, parseConfig } from "../src/config.ts";
import { inWindow } from "../src/maintenance.ts";
import { formatDuration, parseDuration } from "../src/util.ts";

describe("durations", () => {
  test("parses", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration(2500)).toBe(2500);
    expect(parseDuration("1.5m")).toBe(90_000);
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("5x")).toBeNull();
  });
  test("formats", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(5_400_000)).toBe("1h 30m");
    expect(formatDuration(90_061_000)).toBe("1d 1h");
  });
});

describe("http helpers", () => {
  test("status patterns", () => {
    expect(statusMatches(204, ["2xx"])).toBe(true);
    expect(statusMatches(404, ["2xx", "3xx"])).toBe(false);
    expect(statusMatches(403, ["400-404"])).toBe(true);
    expect(statusMatches(418, ["418"])).toBe(true);
  });
  test("json paths", () => {
    const data = { a: { b: [{ c: 1 }, { c: 2 }] } };
    expect(getPath(data, "a.b[1].c")).toBe(2);
    expect(getPath(data, "a.x.y")).toBeUndefined();
  });
});

test("templates", () => {
  const ctx = { monitor: { name: 'api "v2"' }, n: 3 };
  expect(render("{{monitor.name}} / {{ n }}", ctx)).toBe('api "v2" / 3');
  expect(render('{"m": {{monitor.name|json}}}', ctx)).toBe('{"m": "api \\"v2\\""}');
});

describe("maintenance windows", () => {
  // 2026-10-05 is a Monday.
  const at = (iso: string) => new Date(iso);
  test("same-day window", () => {
    const w = { days: [1], start: 120, end: 240, timezone: "UTC" };
    expect(inWindow(w, at("2026-10-05T03:00:00Z"))).toBe(true);
    expect(inWindow(w, at("2026-10-05T04:00:00Z"))).toBe(false);
    expect(inWindow(w, at("2026-10-06T03:00:00Z"))).toBe(false);
  });
  test("wraps past midnight onto the next day", () => {
    const w = { days: [1], start: 23 * 60, end: 60, timezone: "UTC" };
    expect(inWindow(w, at("2026-10-05T23:30:00Z"))).toBe(true);
    expect(inWindow(w, at("2026-10-06T00:30:00Z"))).toBe(true); // Tuesday early, belongs to Monday
    expect(inWindow(w, at("2026-10-05T00:30:00Z"))).toBe(false); // Monday early, belongs to Sunday
  });
  test("one-off window", () => {
    const w = { days: [], from: Date.parse("2026-10-05T00:00:00Z"), until: Date.parse("2026-10-05T01:00:00Z") };
    expect(inWindow(w, at("2026-10-05T00:59:00Z"))).toBe(true);
    expect(inWindow(w, at("2026-10-05T01:00:00Z"))).toBe(false);
  });
});

describe("config", () => {
  test("applies defaults and env vars", () => {
    process.env.TEST_HOOK = "https://discord.test/hook";
    const cfg = parseConfig(
      {
        defaults: { interval: "30s", alerts: ["discord"], maintenance: [{ start: "02:00", end: "03:00" }] },
        alerts: { discord: { type: "discord", url: "${TEST_HOOK}" } },
        monitors: [
          { name: "site", type: "http", url: "https://example.com", alerts: ["discord", { to: "discord", after: "10m" }] },
          { name: "dns", type: "udp", host: "1.1.1.1", port: 53, send: "00", encoding: "hex", interval: "5m" },
        ],
      },
      "/tmp/config.yaml",
    );
    const [site, udp] = cfg.monitors;
    expect(site!.interval).toBe(30_000);
    expect(site!.alerts).toEqual([{ to: "discord", after: 0 }, { to: "discord", after: 600_000 }]);
    expect(site!.maintenance).toHaveLength(1);
    expect(udp!.interval).toBe(300_000);
    expect(udp!.alerts).toEqual([{ to: "discord", after: 0 }]);
    expect(cfg.alerters.get("discord")).toMatchObject({ url: "https://discord.test/hook" });
  });

  test("reports every problem at once", () => {
    try {
      parseConfig(
        {
          monitors: [
            { name: "a", type: "http", url: "notaurl", interval: "soon" },
            { name: "b", type: "tcp", host: "x", alerts: ["missing"] },
            { name: "a", type: "ping" },
          ],
        },
        "c.yaml",
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const text = (err as ConfigError).problems.join("\n");
      expect(text).toContain("invalid URL");
      expect(text).toContain('invalid duration "soon"');
      expect(text).toContain("port: is required");
      expect(text).toContain('unknown alerter "missing"');
      expect(text).toContain("duplicate name");
      expect(text).toContain("must be one of");
    }
  });
});
