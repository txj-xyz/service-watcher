import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, ConflictError } from "../src/app.ts";
import { ConfigError, STARTER_CONFIG, parseConfig, stringifyConfig } from "../src/config.ts";

let app: App | undefined;
let dir: string;

afterEach(() => {
  app?.stop();
  app = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  dir = mkdtempSync(join(tmpdir(), "watcher-"));
  const path = join(dir, "config.yaml");
  const raw = { ...STARTER_CONFIG, storage: { path: ":memory:" } };
  const text = stringifyConfig(raw);
  await Bun.write(path, text);
  app = new App(parseConfig(Bun.YAML.parse(text), path), text);
  return { path, raw };
}

test("saves UI edits to YAML, keeping env placeholders, with a backup", async () => {
  const { path, raw } = await setup();
  const next = {
    ...raw,
    alerts: { d: { type: "discord", url: "${HOOK_URL:-https://example.com/hook}" } },
    monitors: [{ name: "site", type: "http", url: "https://example.com", alerts: ["d"], enabled: false }],
  };
  await app!.saveConfig(next, app!.version);
  const written = await Bun.file(path).text();
  expect(written).toContain('url: "${HOOK_URL:-https://example.com/hook}"');
  expect(Bun.YAML.parse(written)).toEqual(next);
  expect(await Bun.file(`${path}.bak`).exists()).toBe(true);
  expect(app!.config.alerters.get("d")).toMatchObject({ url: "https://example.com/hook" });
  expect(app!.config.raw).toEqual(next);
});

test("rejects stale versions and invalid configs without touching the file", async () => {
  const { path, raw } = await setup();
  const before = await Bun.file(path).text();
  await expect(app!.saveConfig(raw, "stale")).rejects.toBeInstanceOf(ConflictError);
  await expect(app!.saveConfig({ monitors: [{ name: "x", type: "http", url: "nope" }] }, app!.version)).rejects.toBeInstanceOf(ConfigError);
  expect(await Bun.file(path).text()).toBe(before);
});

test("an outside edit changes the version so UI saves based on old data conflict", async () => {
  const { path, raw } = await setup();
  const old = app!.version;
  await Bun.write(path, stringifyConfig({ ...raw, defaults: { interval: "5m" } }));
  await app!.reload();
  expect(app!.version).not.toBe(old);
  expect(app!.config.raw.defaults).toEqual({ interval: "5m" });
  await expect(app!.saveConfig(raw, old)).rejects.toBeInstanceOf(ConflictError);
});
