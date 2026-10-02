import type { Notifier } from "./alerts/index.ts";
import { runCheck } from "./checks/index.ts";
import { log } from "./log.ts";
import { inMaintenance } from "./maintenance.ts";
import type { Store } from "./store.ts";
import type { AlertEvent, CheckResult, EventKind, MonitorConfig, Status } from "./types.ts";
import { describeTarget, formatDuration } from "./util.ts";

export interface MonitorDeps {
  store: Store;
  notifier: Notifier;
  /** Injectable for tests. */
  check?: (m: MonitorConfig) => Promise<CheckResult>;
  now?: () => number;
}

export class Monitor {
  status: Status = "pending";
  lastResult?: CheckResult;
  lastCheckAt?: number;
  nextCheckAt?: number;
  consecutiveFailures = 0;
  consecutiveSuccesses = 0;
  /** When the current down/degraded incident started. */
  incidentStart?: number;
  /** Alert routes that were told about the current incident (they get the recovery). */
  notified = new Set<string>();
  private lastNotifyAt?: number;
  private failingSince?: number;
  private timer?: Timer;
  private running?: Promise<CheckResult | undefined>;
  private stopped = true;

  constructor(
    public cfg: MonitorConfig,
    private deps: MonitorDeps,
  ) {
    if (deps.store.isPaused(cfg.name)) this.status = "paused";
  }

  get paused() {
    return this.status === "paused";
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  start(initialDelay = 0) {
    this.stopped = false;
    this.schedule(initialDelay);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.nextCheckAt = undefined;
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.nextCheckAt = Date.now() + delay;
    this.timer = setTimeout(async () => {
      await this.runOnce().catch((err) => log.error(`Monitor ${this.cfg.name} crashed`, { error: String(err) }));
      this.schedule(this.cfg.interval);
    }, delay);
  }

  /** Run a check right now and restart the interval from here. */
  async checkNow(): Promise<CheckResult | undefined> {
    clearTimeout(this.timer);
    try {
      return await this.runOnce(true);
    } finally {
      this.schedule(this.cfg.interval);
    }
  }

  pause() {
    this.status = "paused";
    this.deps.store.setPaused(this.cfg.name, true);
    log.info(`Paused ${this.cfg.name}`);
  }

  resume() {
    if (!this.paused) return;
    this.deps.store.setPaused(this.cfg.name, false);
    this.resetCounters();
    log.info(`Resumed ${this.cfg.name}`);
    void this.checkNow();
  }

  private resetCounters() {
    this.status = "pending";
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.incidentStart = undefined;
    this.failingSince = undefined;
    this.notified.clear();
  }

  /** Runs one check and evaluates it. Concurrent calls share the in-flight check. */
  runOnce(force = false): Promise<CheckResult | undefined> {
    this.running ??= this.execute(force).finally(() => (this.running = undefined));
    return this.running;
  }

  private async execute(force: boolean): Promise<CheckResult | undefined> {
    if (this.paused) return undefined;
    if (!force && inMaintenance(this.cfg.maintenance, new Date(this.now()))) {
      if (this.status !== "maintenance") {
        log.info(`${this.cfg.name} entered maintenance window — checks and alerts suspended`);
        this.resetCounters();
        this.status = "maintenance";
      }
      return undefined;
    }
    if (this.status === "maintenance") {
      log.info(`${this.cfg.name} left maintenance window`);
      this.status = "pending";
    }

    const result = await (this.deps.check ?? runCheck)(this.cfg);
    if (this.paused) return result; // paused while the check was running
    this.lastResult = result;
    this.lastCheckAt = this.now();
    this.deps.store.recordCheck(this.cfg.name, this.lastCheckAt, result);
    log.debug(`${result.ok ? (result.degraded ? "SLOW" : "OK  ") : "FAIL"} ${this.cfg.name}: ${result.message}`, {
      latency: `${Math.round(result.latencyMs)}ms`,
    });
    await this.evaluate(result);
    return result;
  }

  private async evaluate(r: CheckResult) {
    const prev = this.status;
    const now = this.now();

    if (r.ok) {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses++;
      this.failingSince = undefined;
      const next: Status = r.degraded ? "degraded" : "up";

      if (prev === "down") {
        if (this.consecutiveSuccesses < this.cfg.recoveryThreshold) return;
        this.setStatus(next);
        await this.emit("up", prev, r);
        if (next === "degraded") {
          this.incidentStart = now;
          await this.emit("degraded", "up", r);
        }
      } else if (prev !== next) {
        this.setStatus(next);
        if (next === "degraded") {
          this.incidentStart = now;
          await this.emit("degraded", prev, r);
        } else if (prev === "degraded") {
          await this.emit("up", prev, r);
        }
      } else if (next === "degraded") {
        await this.maybeRemind(r);
      }
      return;
    }

    this.consecutiveSuccesses = 0;
    this.consecutiveFailures++;
    this.failingSince ??= now;

    if (prev !== "down") {
      if (this.consecutiveFailures < this.cfg.failureThreshold) {
        log.warn(`${this.cfg.name} failed (${this.consecutiveFailures}/${this.cfg.failureThreshold}): ${r.message}`);
        return;
      }
      this.setStatus("down");
      this.incidentStart = this.failingSince;
      // Anyone told about a prior "degraded" will hear about "down" anyway via their route.
      this.notified.clear();
      await this.emit("down", prev, r);
    } else {
      await this.maybeRemind(r);
    }
    await this.escalate(r);
  }

  private setStatus(s: Status) {
    if (s === this.status) return;
    const level = s === "down" ? "error" : s === "degraded" ? "warn" : "info";
    log[level](`${this.cfg.name}: ${this.status} → ${s}`, { message: this.lastResult?.message });
    this.status = s;
  }

  private async maybeRemind(r: CheckResult) {
    if (!this.cfg.renotify || this.lastNotifyAt === undefined || !this.notified.size) return;
    if (this.now() - this.lastNotifyAt >= this.cfg.renotify) await this.emit("reminder", this.status, r);
  }

  /** Delayed routes: alert once the incident has lasted at least `after`. */
  private async escalate(r: CheckResult) {
    if (this.status !== "down" || this.incidentStart === undefined || !this.cfg.notifyOn.includes("down")) return;
    const elapsed = this.now() - this.incidentStart;
    const due = this.cfg.alerts.filter((a) => a.after > 0 && elapsed >= a.after && !this.notified.has(a.to));
    if (!due.length) return;
    log.warn(`${this.cfg.name} down for ${formatDuration(elapsed)} — escalating to ${due.map((a) => a.to).join(", ")}`);
    const event = this.buildEvent("down", "down", r);
    await Promise.all(due.map((a) => this.sendTo(a.to, event)));
  }

  private buildEvent(kind: EventKind, previousStatus: Status, r: CheckResult): AlertEvent {
    const now = this.now();
    return {
      kind,
      monitor: {
        name: this.cfg.name,
        type: this.cfg.type,
        target: describeTarget(this.cfg),
        description: this.cfg.description,
        tags: this.cfg.tags,
      },
      status: this.status,
      previousStatus,
      result: r,
      since: this.incidentStart,
      duration: this.incidentStart !== undefined && kind !== "down" && kind !== "degraded" ? now - this.incidentStart : undefined,
      timestamp: now,
    };
  }

  private async sendTo(route: string, event: AlertEvent) {
    // Mark before sending so a slow or failing alerter is not re-escalated every tick.
    if (event.kind === "down" || event.kind === "degraded") this.notified.add(route);
    await this.deps.notifier.send(route, event);
  }

  private async emit(kind: EventKind, prev: Status, r: CheckResult) {
    const event = this.buildEvent(kind, prev, r);
    this.deps.store.recordEvent(event);
    if (kind === "up") {
      this.incidentStart = undefined;
    }
    if (!this.cfg.notifyOn.includes(kind)) {
      if (kind === "up") this.notified.clear();
      return;
    }

    // Down/degraded go to immediate routes; reminders and recoveries go to whoever heard about the incident.
    const routes =
      kind === "up" || kind === "reminder"
        ? [...this.notified]
        : this.cfg.alerts.filter((a) => a.after === 0).map((a) => a.to);
    if (kind === "up") this.notified.clear();
    this.lastNotifyAt = this.now();
    await Promise.all(routes.map((to) => this.sendTo(to, event)));
  }

  snapshot() {
    return {
      name: this.cfg.name,
      type: this.cfg.type,
      target: describeTarget(this.cfg),
      description: this.cfg.description,
      tags: this.cfg.tags,
      status: this.status,
      enabled: this.cfg.enabled,
      interval: this.cfg.interval,
      lastCheckAt: this.lastCheckAt,
      nextCheckAt: this.nextCheckAt,
      lastResult: this.lastResult,
      consecutiveFailures: this.consecutiveFailures,
      incidentStart: this.incidentStart,
    };
  }
}
