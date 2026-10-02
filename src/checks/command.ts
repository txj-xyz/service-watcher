import type { CheckResult, CommandMonitorConfig } from "../types.ts";
import { errorMessage, truncate } from "../util.ts";

export async function checkCommand(m: CommandMonitorConfig): Promise<CheckResult> {
  const started = performance.now();
  const cmd = Array.isArray(m.command) ? m.command : ["sh", "-c", m.command];
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", timeout: m.timeout, killSignal: "SIGKILL" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const latencyMs = performance.now() - started;
    const output = (stdout.trim() || stderr.trim()).split("\n").at(-1) ?? "";
    const details = { exitCode: code, stdout: truncate(stdout, 2000), stderr: truncate(stderr, 2000) };
    if (proc.signalCode) return { ok: false, latencyMs, message: `Killed (${proc.signalCode}) — timed out after ${m.timeout}ms?`, details };
    if (code !== m.expectExitCode)
      return { ok: false, latencyMs, message: `Exit code ${code} (expected ${m.expectExitCode})${output ? `: ${truncate(output, 150)}` : ""}`, details };
    if (m.contains && !stdout.includes(m.contains))
      return { ok: false, latencyMs, message: `Output does not contain "${m.contains}"`, details };
    return { ok: true, latencyMs, message: output ? truncate(output, 150) : `Exit code ${code}`, details };
  } catch (err) {
    return { ok: false, latencyMs: performance.now() - started, message: errorMessage(err) };
  }
}
