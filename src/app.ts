import { copyFile, rename, unlink } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { Notifier } from "./alerts/index.ts";
import { ConfigError, parseConfig, readConfigFile, stringifyConfig } from "./config.ts";
import { configureLog, log } from "./log.ts";
import { Monitor } from "./monitor.ts";
import { Store } from "./store.ts";
import type { AppConfig } from "./types.ts";

const PRUNE_EVERY = 60 * 60 * 1000;

export class ConflictError extends Error {}

/** Write-then-rename so a crash never leaves a half-written config. */
async function writeAtomic(path: string, text: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await Bun.write(tmp, text);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    const code = (err as { code?: string }).code;
    // A file bind-mounted on its own (docker -v ./config.yaml:/data/config.yaml) can't be replaced, only rewritten.
    if (code !== "EBUSY" && code !== "EXDEV" && code !== "EACCES" && code !== "EPERM") throw err;
    await Bun.write(path, text);
  }
}

const hash = (text: string) => Bun.hash(text).toString(16);

export class App {
  monitors = new Map<string, Monitor>();
  notifier: Notifier;
  store: Store;
  /** Hash of the config file as last read or written; the UI sends it back to detect concurrent edits. */
  version: string;
  /** Problems with the file on disk when it failed to load (the previous valid config stays active). */
  fileProblems: string[] = [];
  private watcher?: FSWatcher;
  private pruneTimer?: Timer;
  private saving = Promise.resolve();
  readonly startedAt = Date.now();
  /** Settings that only take effect at startup. */
  private readonly bootSettings: string;

  constructor(
    public config: AppConfig,
    text: string,
  ) {
    this.version = hash(text);
    this.store = new Store(config.storage.path);
    this.notifier = new Notifier(config.alerters);
    this.bootSettings = this.restartKey(config);
  }

  private restartKey(c: AppConfig) {
    return JSON.stringify([c.server.enabled, c.server.host, c.server.port, c.storage.path]);
  }

  get restartRequired() {
    return this.restartKey(this.config) !== this.bootSettings;
  }

  start() {
    this.applyMonitors();
    this.prune();
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_EVERY);
    log.info(`Watching ${this.monitors.size} monitor(s) with ${this.config.alerters.size} alerter(s)`);
  }

  /** Starts new monitors, restarts changed ones and keeps the state of unchanged ones. */
  private applyMonitors() {
    const wanted = new Map(this.config.monitors.filter((m) => m.enabled).map((m) => [m.name, m]));
    for (const [name, mon] of this.monitors) {
      const next = wanted.get(name);
      if (!next) {
        mon.stop();
        this.monitors.delete(name);
        log.info(`Removed monitor ${name}`);
      } else if (JSON.stringify(next) !== JSON.stringify(mon.cfg)) {
        mon.stop();
        this.monitors.delete(name);
        log.info(`Monitor ${name} changed, restarting`);
      }
    }
    let i = 0;
    for (const [name, cfg] of wanted) {
      if (this.monitors.has(name)) continue;
      const mon = new Monitor(cfg, { store: this.store, notifier: this.notifier });
      this.monitors.set(name, mon);
      // Stagger first checks so a big config doesn't fire everything at once.
      mon.start(Math.min(i++ * 250, cfg.interval));
    }
  }

  private apply(next: AppConfig) {
    configureLog(next.log);
    this.config = next;
    this.notifier.alerters = next.alerters;
    this.applyMonitors();
    if (this.restartRequired) log.warn("server/storage settings changed — restart to apply them");
  }

  /** Re-reads the file after an outside edit. Invalid files are reported and ignored. */
  async reload() {
    let text: string | undefined;
    try {
      const file = await readConfigFile(this.config.path);
      text = file.text;
      if (hash(text) === this.version) return; // our own write, or nothing changed
      this.version = hash(text);
      this.apply(parseConfig(file.raw, this.config.path));
      this.fileProblems = [];
      log.info(`Config reloaded: ${this.monitors.size} monitor(s), ${this.config.alerters.size} alerter(s)`);
    } catch (err) {
      if (text !== undefined) this.version = hash(text);
      this.fileProblems = err instanceof ConfigError ? err.problems : [String(err)];
      log.error(err instanceof ConfigError ? err.message : `Reload failed: ${err}`);
      log.error("Keeping the previous config");
    }
  }

  /** Validates, writes and applies a config edited in the UI. Throws ConfigError or ConflictError. */
  saveConfig(raw: unknown, baseVersion?: string): Promise<void> {
    // Serialize saves so two quick edits can't interleave their writes.
    const run = this.saving.then(async () => {
      const path = this.config.path;
      const current = await Bun.file(path).text().catch(() => "");
      if (baseVersion && hash(current) !== baseVersion)
        throw new ConflictError("The config file changed since you loaded it. Reload the page to get the latest version.");
      const next = parseConfig(raw, path);
      const text = path.endsWith(".json") ? JSON.stringify(raw, null, 2) + "\n" : stringifyConfig(raw);
      if (current) await copyFile(path, `${path}.bak`);
      await writeAtomic(path, text);
      this.version = hash(text);
      this.fileProblems = [];
      this.apply(next);
      log.info(`Config saved from web UI: ${this.monitors.size} monitor(s), ${this.config.alerters.size} alerter(s)`);
    });
    this.saving = run.catch(() => {});
    return run;
  }

  watchConfig() {
    // Watch the directory: editors often replace the file instead of writing it in place.
    const file = basename(this.config.path);
    let debounce: Timer | undefined;
    this.watcher = watch(dirname(this.config.path), (_event, changed) => {
      if (changed !== file) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => this.reload(), 300);
    });
    log.info(`Hot-reloading config from ${this.config.path}`);
  }

  private prune() {
    const removed = this.store.prune(Date.now() - this.config.storage.retention);
    if (removed) log.debug(`Pruned ${removed} old rows`);
  }

  stop() {
    for (const m of this.monitors.values()) m.stop();
    this.watcher?.close();
    clearInterval(this.pruneTimer);
    this.store.close();
  }
}
