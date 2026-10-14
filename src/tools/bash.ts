/**
 * `bash` — run a shell command in the workspace.
 *
 * The most powerful tool in the set, so its semantics are chosen carefully:
 *
 * - a **non-zero exit code is information, not a failure**. `npm test` failing is
 *   the normal case a coding agent exists to handle; throwing here would convert the
 *   most useful observation in the system into an error and stop the loop.
 * - a **timeout is reported**, not thrown, so the model can react (retry with a
 *   narrower command) instead of the run dying.
 * - **cancellation is an abort**, thrown as `AbortError`, because a fired signal is a
 *   lifecycle state and must not be mistaken for a tool fault.
 * - output is captured under a shared byte cap across both streams, so one runaway
 *   command cannot exhaust memory or the context window.
 */

import { spawn } from "node:child_process";
import { z } from "zod";

import { toolOutput } from "../core/contracts.ts";
import type { ToolDefinition } from "./types.ts";

const BashInput = z.object({
  command: z.string().min(1).describe("Shell command to run in the workspace root"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(600_000)
    .optional()
    .describe("Wall-clock limit in milliseconds (default 120000)"),
});

export type BashInput = z.infer<typeof BashInput>;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_CHARS = 200_000;

export const bashTool: ToolDefinition<BashInput> = {
  name: "bash",
  description:
    "Run a shell command in the workspace root. Returns exit code, stdout and stderr. " +
    "A non-zero exit code is reported, not treated as a tool failure.",

  schema: BashInput,

  async execute(input, ctx) {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const result = await runCommand(
      input.command,
      ctx.cwd,
      timeoutMs,
      ctx.signal,
      // Never inherit the agent's own credentials into a model-written command.
      ctx.env ?? process.env,
    );

    const sections: string[] = [];
    if (result.timedOut) {
      sections.push(`TIMED OUT after ${timeoutMs}ms (process killed)`);
    }
    sections.push(`exit code: ${result.exitCode ?? `signal ${String(result.signal)}`}`);

    if (result.stdout.length > 0) {
      sections.push(`--- stdout ---\n${result.stdout}${result.stdoutTruncated ? "\n… [stdout truncated]" : ""}`);
    }
    if (result.stderr.length > 0) {
      sections.push(`--- stderr ---\n${result.stderr}${result.stderrTruncated ? "\n… [stderr truncated]" : ""}`);
    }
    if (result.stdout.length === 0 && result.stderr.length === 0) {
      sections.push("(no output)");
    }

    return toolOutput(sections.join("\n"), {
      command: input.command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    });
  },
};

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

/** A capture buffer sharing one global character budget across both streams. */
function createCaptureBudget(limit: number) {
  let remaining = limit;
  return {
    take(text: string): { text: string; truncated: boolean } {
      if (remaining <= 0) return { text: "", truncated: true };
      if (text.length <= remaining) {
        remaining -= text.length;
        return { text, truncated: false };
      }
      const slice = text.slice(0, remaining);
      remaining = 0;
      return { text: slice, truncated: true };
    },
  };
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  // A signal that already fired must not spawn a process at all.
  signal.throwIfAborted();

  return new Promise<CommandResult>((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, { shell: true, cwd, env });
    const budget = createCaptureBudget(MAX_CAPTURE_CHARS);

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const onAbort = (): void => {
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      const taken = budget.take(chunk.toString("utf8"));
      stdout += taken.text;
      if (taken.truncated) stdoutTruncated = true;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const taken = budget.take(chunk.toString("utf8"));
      stderr += taken.text;
      if (taken.truncated) stderrTruncated = true;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });

    child.on("close", (code, signalName) => {
      if (settled) return;

      if (signal.aborted) {
        // Cancellation is a lifecycle state, not a tool result.
        settled = true;
        cleanup();
        reject(new DOMException("tool execution aborted", "AbortError"));
        return;
      }

      settled = true;
      cleanup();
      resolve({
        exitCode: code,
        signal: signalName,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
