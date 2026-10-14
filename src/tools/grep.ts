/**
 * `grep` — search file contents.
 *
 * Binary files are skipped by sniffing for a NUL byte rather than by extension,
 * because extensions lie. The result cap exists so one match in a lockfile cannot
 * flood the context.
 */

import fs from "node:fs/promises";
import path from "node:path";
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

export const grepTool: ToolDefinition<GrepInput> = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns 'path:line: text' matches. " +
    "Skips binaries and dependency directories.",
  schema: GrepInput,

  async execute(input, ctx) {
    let expression: RegExp;
    try {
      expression = new RegExp(input.pattern, input.ignoreCase === true ? "i" : "");
    } catch (error) {
      throw new AgentError("invalid_tool", `invalid regular expression: ${String(error)}`);
    }

    const root = resolveWithinWorkspace(ctx.cwd, input.path ?? ".");
    const limit = input.maxResults ?? DEFAULT_MAX_RESULTS;
    const matches: string[] = [];
    let filesScanned = 0;
    let truncated = false;

    for await (const relative of walkFiles({ root, signal: ctx.signal })) {
      if (matches.length >= limit) {
        truncated = true;
        break;
      }

      const absolute = path.join(root, relative);
      const text = await readTextOrUndefined(absolute);
      if (text === undefined) continue;
      filesScanned += 1;

      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined) continue;
        if (!expression.test(line)) continue;

        const rendered = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
        matches.push(`${relative}:${index + 1}: ${rendered}`);
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
      }
    }

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
