import { log } from "../log.ts";
import type { AlertEvent, AlerterConfig } from "../types.ts";
import { errorMessage } from "../util.ts";
import { SendError, deliver } from "./providers.ts";

const MAX_RETRY_WAIT = 60_000;

export class Notifier {
  constructor(public alerters: Map<string, AlerterConfig>) {}

  /** Sends to one alerter with retries. Resolves true on success; never throws. */
  async send(name: string, event: AlertEvent): Promise<boolean> {
    const cfg = this.alerters.get(name);
    if (!cfg) {
      log.warn(`Unknown alerter "${name}"`, { monitor: event.monitor.name });
      return false;
    }
    if (!cfg.events.includes(event.kind)) {
      log.debug(`Alerter ${name} skips ${event.kind} events`);
      return true;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await deliver(cfg, event);
        log.info(`Alert sent`, { alerter: name, kind: event.kind, monitor: event.monitor.name });
        return true;
      } catch (err) {
        const retryable = !(err instanceof SendError) || err.retryable;
        if (!retryable || attempt >= cfg.retries) {
          log.error(`Alert failed`, { alerter: name, kind: event.kind, monitor: event.monitor.name, error: errorMessage(err) });
          return false;
        }
        const wait = Math.min((err instanceof SendError && err.retryAfterMs) || 1000 * 2 ** attempt, MAX_RETRY_WAIT);
        log.warn(`Alert attempt ${attempt + 1} failed, retrying in ${Math.round(wait)}ms`, { alerter: name, error: errorMessage(err) });
        await Bun.sleep(wait);
      }
    }
  }
}
