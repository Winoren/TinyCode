/**
 * `read` — inspect a text file.
 *
 * Line numbers are included because a coding model reasons far more accurately
 * about "line 42" than about an unanchored blob, and because it makes a partial
 * read (`offset`/`limit`) legible. `edit` matches on text, not on line numbers, so
 * the numbering costs nothing downstream.
 */

import fs from "node:fs/promises";
import { z } from "zod";

import { AgentError, toolOutput } from "../core/contracts.ts";
import { resolveWithinWorkspace } from "./paths.ts";
import type { ToolDefinition } from "./types.ts";

const ReadInput = z.object({
  path: z.string().min(1).describe("File path relative to the workspace root"),
  offset: z.number().int().positive().optional().describe("1-based first line to read"),
  limit: z.number().int().positive().optional().describe("Maximum number of lines to read"),
});

export type ReadInput = z.infer<typeof ReadInput>;

const MAX_LINES = 2_000;

export const readTool: ToolDefinition<ReadInput> = {
  name: "read",
  description:
    "Read a UTF-8 text file inside the workspace. Returns numbered lines. " +
    "Use offset/limit for large files.",

  schema: ReadInput,

  async execute(input, ctx): Promise<ReturnType<typeof toolOutput>> {
    const absolute = resolveWithinWorkspace(ctx.cwd, input.path);

    let raw: string;
    try {
      raw = await fs.readFile(absolute, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new AgentError("invalid_tool", `file not found: ${input.path}`);
      }
      if (code === "EISDIR") {
        throw new AgentError("invalid_tool", `not a file: ${input.path} (use ls for directories)`);
      }
      throw error;
    }

    const lines = raw.split("\n");
    const start = (input.offset ?? 1) - 1;
    const requested = input.limit ?? MAX_LINES;
    const end = Math.min(start + requested, lines.length);
    const slice = lines.slice(start, end);

    const width = String(end).length;
    const numbered = slice
      .map((line, index) => `${String(start + index + 1).padStart(width, " ")}  ${line}`)
      .join("\n");

    const truncated = end < lines.length;
    const notice = truncated ? `\n… [${lines.length - end} more lines; pass offset to continue]` : "";

    return toolOutput(`${numbered}${notice}`, {
      path: input.path,
      totalLines: lines.length,
      returnedLines: slice.length,
      truncated,
    });
  },
};
