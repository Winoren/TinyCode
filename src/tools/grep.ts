/**
 * `grep` — search file contents.
 *
 * Binary files are skipped by sniffing for a NUL byte rather than by extension, because
 * extensions lie. The result cap exists so one match in a lockfile cannot flood the
 * context.
 *
 * ## Why the matching runs inside a `vm` context
 *
 * The pattern comes from the model, and V8 has **no regex timeout**. A catastrophic
 * pattern — `(a+)+$` is the textbook one — sends `RegExp.test` into exponential
 * backtracking, and because that is synchronous JavaScript, a fired `AbortSignal` cannot
 * interrupt it. The run would hang past every budget, breaking the Runtime's guarantee
 * that budgets terminate a run predictably.
 *
 * `vm.runInContext(..., { timeout })` interrupts via the V8 terminator and *can* break
 * out of a backtracking regex. Verified before implementing, including that the process
 * stays healthy afterwards: subsequent `vm` execution, timers, and ordinary JavaScript
 * all still work.
 *
 * The pattern is passed as sandbox **data**, never interpolated into source — the script
 * below is a fixed string, so a pattern cannot become code.
 */

import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { z } from "zod";

import { AgentError, toolOutput } from "../core/contracts.ts";
import { looksBinary } from "./binary.ts";
import { resolveWithinWorkspace } from "./paths.ts";
import type { ToolDefinition } from "./types.ts";
import { walkFiles } from "./walk.ts";

const GrepInput = z.object({
  pattern: z.string().min(1).describe("JavaScript regular expression to search for"),
  path: z.string().optional().describe("Directory to search, relative to the workspace root"),
  ignoreCase: z.boolean().optional(),
  maxResults: z.number().int().positive().max(1_000).optional(),
});

export type GrepInput = z.infer<typeof GrepInput>;

const DEFAULT_MAX_RESULTS = 200;
const MAX_LINE_LENGTH = 400;
const MAX_FILE_BYTES = 2_000_000;

/** Total time all regex evaluation may consume in one call. */
export const REGEX_TOTAL_BUDGET_MS = 2_000;

/** Bytes of file text handed to one `vm` execution, bounding memory and latency. */
export const REGEX_BATCH_BYTES = 4 * 1024 * 1024;

interface BatchFile {
  path: string;
  lines: string[];
}

interface MatcherResult {
  matches: string[];
  truncated: boolean;
}

/**
 * A fixed script. `pattern` and `files` arrive as sandbox globals, so nothing the model
 * supplies is ever evaluated as source.
 */
const MATCHER_SOURCE = `(function () {
  var expression = new RegExp(pattern, flags);
  var output = [];
  var truncated = false;
  outer:
  for (var f = 0; f < files.length; f += 1) {
    var file = files[f];
    for (var i = 0; i < file.lines.length; i += 1) {
      var line = file.lines[i];
      if (!expression.test(line)) continue;
      var rendered = line.length > maxLineLength ? line.slice(0, maxLineLength) + "\\u2026" : line;
      output.push(file.path + ":" + (i + 1) + ": " + rendered);
      if (output.length >= maxResults) { truncated = true; break outer; }
    }
  }
  result = { matches: output, truncated: truncated };
})();`;

export const grepTool: ToolDefinition<GrepInput> = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns 'path:line: text' matches. " +
    "Skips binaries and dependency directories.",
  schema: GrepInput,

  async execute(input, ctx) {
    const flags = input.ignoreCase === true ? "i" : "";

    // Validate in the main thread first, so a malformed pattern is reported immediately
    // rather than surfacing as a sandbox failure.
    try {
      new RegExp(input.pattern, flags);
    } catch (error) {
      throw new AgentError("invalid_tool", `invalid regular expression: ${String(error)}`);
    }

    const root = resolveWithinWorkspace(ctx.cwd, input.path ?? ".");
    const limit = input.maxResults ?? DEFAULT_MAX_RESULTS;
    const deadline = Date.now() + REGEX_TOTAL_BUDGET_MS;

    const matches: string[] = [];
    let filesScanned = 0;
    let truncated = false;
    let batch: BatchFile[] = [];
    let batchBytes = 0;

    const flush = (): void => {
      if (batch.length === 0) return;

      const remaining = deadline - Date.now();
      if (remaining <= 0) throw regexBudgetExhausted(input.pattern);

      const outcome = evaluateBatch(batch, {
        pattern: input.pattern,
        flags,
        maxResults: limit - matches.length,
        remainingMs: remaining,
      });

      matches.push(...outcome.matches);
      if (outcome.truncated) truncated = true;
      batch = [];
      batchBytes = 0;
    };

    for await (const relative of walkFiles({ root, signal: ctx.signal })) {
      if (matches.length >= limit) {
        truncated = true;
        break;
      }

      const text = await readTextOrUndefined(path.join(root, relative));
      if (text === undefined) continue;
      filesScanned += 1;

      batch.push({ path: relative, lines: text.split(/\r?\n/) });
      batchBytes += text.length;
      if (batchBytes >= REGEX_BATCH_BYTES) flush();
      if (truncated) break;
    }
    flush();

    const body =
      matches.length === 0
        ? `No matches for /${input.pattern}/`
        : matches.join("\n") + (truncated ? `\n… [stopped at ${limit} matches]` : "");

    return toolOutput(body, {
      pattern: input.pattern,
      matchCount: matches.length,
      filesScanned,
      truncated,
    });
  },
};

interface EvaluateOptions {
  pattern: string;
  flags: string;
  maxResults: number;
  remainingMs: number;
}

function evaluateBatch(files: readonly BatchFile[], options: EvaluateOptions): MatcherResult {
  // The remaining budget only shrinks, so no single batch can exceed it and the whole
  // call stays bounded however many batches the walk produces.
  const sandbox: Record<string, unknown> = {
    pattern: options.pattern,
    flags: options.flags,
    files,
    maxResults: Math.max(1, options.maxResults),
    maxLineLength: MAX_LINE_LENGTH,
    result: undefined,
  };

  let context: vm.Context;
  try {
    context = vm.createContext(sandbox);
  } catch (error) {
    throw new AgentError("invalid_tool", `could not prepare the search: ${String(error)}`);
  }

  try {
    new vm.Script(MATCHER_SOURCE).runInContext(context, { timeout: options.remainingMs });
  } catch (error) {
    if (isVmTimeout(error)) throw regexBudgetExhausted(options.pattern);
    if (fieldOf(error, "name") === "SyntaxError") {
      throw new AgentError("invalid_tool", `invalid regular expression: ${String(fieldOf(error, "message"))}`);
    }
    throw error;
  }

  const result = sandbox.result as MatcherResult | undefined;
  if (result === undefined || !Array.isArray(result.matches)) {
    throw new AgentError("runtime_error", "the search produced no result");
  }
  return result;
}

/**
 * Read a field from a value that may have come from another realm.
 *
 * Errors thrown out of a `vm` context are created in that context's realm, so
 * `error instanceof Error` is **false** for them even though they are ordinary Errors.
 * Verified directly: the timeout error fails `instanceof Error` and
 * `instanceof SyntaxError` while still carrying a `message`, a `name` and a `code`.
 *
 * This is why the checks below read fields instead of testing types — an `instanceof`
 * guard here silently lets a timeout escape as an unclassified failure, which is exactly
 * what the first version of this code did.
 */
function fieldOf(error: unknown, field: string): unknown {
  if (error === null || typeof error !== "object") return undefined;
  return (error as Record<string, unknown>)[field];
}

function isVmTimeout(error: unknown): boolean {
  if (fieldOf(error, "code") === "ERR_SCRIPT_EXECUTION_TIMEOUT") return true;
  const message = fieldOf(error, "message");
  return typeof message === "string" && message.includes("Script execution timed out");
}

/**
 * A pattern that cannot be evaluated in budget is a bad pattern, not a transient fault —
 * so it is `invalid_tool` and deliberately **not** retryable. Reporting it as `timeout`
 * would make the Runtime retry a pattern that will never get faster.
 */
function regexBudgetExhausted(pattern: string): AgentError {
  return new AgentError(
    "invalid_tool",
    `the pattern /${pattern}/ did not finish within ${REGEX_TOTAL_BUDGET_MS}ms; ` +
      "it is likely to backtrack catastrophically. Simplify it, or search a narrower path.",
  );
}

/** Read a file as text, returning undefined for binaries, oversized files, or I/O errors. */
async function readTextOrUndefined(absolute: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(absolute);
    if (stat.size > MAX_FILE_BYTES) return undefined;

    const buffer = await fs.readFile(absolute);
    if (looksBinary(buffer)) return undefined;

    return buffer.toString("utf8");
  } catch {
    return undefined;
  }
}
