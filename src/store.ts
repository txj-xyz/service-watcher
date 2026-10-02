import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AlertEvent, CheckResult } from "./types.ts";

export interface CheckRow {
  ts: number;
  ok: number;
  degraded: number;
  latency: number;
  message: string;
}

export interface EventRow {
  id: number;
  monitor: string;
  ts: number;
  kind: string;
  status: string;
  message: string;
}

export class Store {
  private db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY, monitor TEXT NOT NULL, ts INTEGER NOT NULL,
      ok INTEGER NOT NULL, degraded INTEGER NOT NULL, latency REAL NOT NULL, message TEXT NOT NULL)`);
    this.db.run("CREATE INDEX IF NOT EXISTS checks_monitor_ts ON checks (monitor, ts)");
    this.db.run(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, monitor TEXT NOT NULL, ts INTEGER NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL)`);
    this.db.run("CREATE INDEX IF NOT EXISTS events_ts ON events (ts)");
    this.db.run("CREATE TABLE IF NOT EXISTS paused (monitor TEXT PRIMARY KEY)");
  }

  recordCheck(monitor: string, ts: number, r: CheckResult) {
    this.db
      .query("INSERT INTO checks (monitor, ts, ok, degraded, latency, message) VALUES (?, ?, ?, ?, ?, ?)")
      .run(monitor, ts, r.ok ? 1 : 0, r.degraded ? 1 : 0, r.latencyMs, r.message);
  }

  recordEvent(e: AlertEvent) {
    this.db
      .query("INSERT INTO events (monitor, ts, kind, status, message) VALUES (?, ?, ?, ?, ?)")
      .run(e.monitor.name, e.timestamp, e.kind, e.status, e.result.message);
  }

  history(monitor: string, limit = 60): CheckRow[] {
    const rows = this.db
      .query("SELECT ts, ok, degraded, latency, message FROM checks WHERE monitor = ? ORDER BY ts DESC LIMIT ?")
      .all(monitor, limit) as CheckRow[];
    return rows.reverse();
  }

  /** Percentage of passing checks and average latency since `since`. */
  uptime(monitor: string, since: number): { uptime: number | null; avgLatency: number | null; checks: number } {
    const row = this.db
      .query("SELECT AVG(ok) * 100 AS uptime, AVG(latency) AS avgLatency, COUNT(*) AS checks FROM checks WHERE monitor = ? AND ts >= ?")
      .get(monitor, since) as { uptime: number | null; avgLatency: number | null; checks: number };
    return row;
  }

  events(limit = 100, monitor?: string): EventRow[] {
    return (
      monitor
        ? this.db.query("SELECT * FROM events WHERE monitor = ? ORDER BY ts DESC LIMIT ?").all(monitor, limit)
        : this.db.query("SELECT * FROM events ORDER BY ts DESC LIMIT ?").all(limit)
    ) as EventRow[];
  }

  isPaused(monitor: string): boolean {
    return this.db.query("SELECT 1 FROM paused WHERE monitor = ?").get(monitor) !== null;
  }

  setPaused(monitor: string, paused: boolean) {
    if (paused) this.db.query("INSERT OR IGNORE INTO paused (monitor) VALUES (?)").run(monitor);
    else this.db.query("DELETE FROM paused WHERE monitor = ?").run(monitor);
  }

  prune(olderThan: number): number {
    const a = this.db.query("DELETE FROM checks WHERE ts < ?").run(olderThan).changes;
    const b = this.db.query("DELETE FROM events WHERE ts < ?").run(olderThan).changes;
    return a + b;
  }

  close() {
    this.db.close();
  }
}
