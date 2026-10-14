/**
 * `read` — inspect a text file.
 *
 * Line numbers are included because a coding model reasons far more accurately about
 * "line 42" than about an unanchored blob, and because it makes a partial read
 * (`offset`/`limit`) legible. `edit` matches on text, not on line numbers, so the
 * numbering costs nothing downstream.
 *
 * Two bounds matter here, and the first version of this tool had neither:
 *
 * - **memory.** Reading a whole file unconditionally meant a multi-gigabyte file
 *   exhausted the process. Small files are read whole (so the line count is exact);
 *   large ones are streamed and only the requested window is retained.
 * - **the transcript.** Truncation happens in the Core, but a binary file is refused
 *   here so it never becomes replacement characters in the first place.
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import readline from "node:readline";
import { z } from "zod";

import { AgentError, toolOutput } from "../core/contracts.ts";
import { looksBinary } from "./binary.ts";
import { throwFsError } from "./fs-errors.ts";
import { resolveWithinWorkspace } from "./paths.ts";
import type { ToolDefinition } from "./types.ts";

const ReadInput = z.object({
  path: z.string().min(1).describe("File path relative to the workspace root"),
  offset: z.number().int().positive().optional().describe("1-based first line to read"),
  limit: z.number().int().positive().optional().describe("Maximum number of lines to read"),
});

export type ReadInput = z.infer<typeof ReadInput>;

const MAX_LINES = 2_000;

/** Above this, the file is streamed rather than held in memory. */
export const MAX_IN_MEMORY_BYTES = 8 * 1024 * 1024;

export const readTool: ToolDefinition<ReadInput> = {
  name: "read",
  description:
    "Read a UTF-8 text file inside the workspace. Returns numbered lines. " +
    "Use offset/limit for large files.",

  schema: ReadInput,

  async execute(input, ctx) {
    const absolute = resolveWithinWorkspace(ctx.cwd, input.path);
    const stats = await statFile(absolute, input.path);

    if (stats.isDirectory()) {
      // Same wording the shared mapper produces, so the message does not depend on which
      // code path noticed the problem.
      throw new AgentError(
        "invalid_tool",
        `not a file: ${input.path} (it is a directory; use ls to list it)`,
      );
    }

    const start = (input.offset ?? 1) - 1;
    const requested = input.limit ?? MAX_LINES;

    if (stats.size <= MAX_IN_MEMORY_BYTES) {
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(absolute);
      } catch (error) {
        throwFsError(error, input.path);
      }
      if (looksBinary(buffer)) throw binaryRefusal(input.path, buffer.length);

      const lines = splitLines(buffer.toString("utf8"));
      const end = Math.min(start + requested, lines.length);
      const numbered = numberLines(lines.slice(start, end), start);
      const truncated = end < lines.length;
      const notice = truncated
        ? `\n… [${lines.length - end} more lines; pass offset to continue]`
        : "";

      return toolOutput(`${numbered}${notice}`, {
        path: input.path,
        totalLines: lines.length,
        returnedLines: Math.max(0, end - start),
        truncated,
      });
    }

    // Large file: retain only the window, and say plainly that the total is unknown
    // rather than paying to count lines in a file we deliberately avoided loading.
    const window = await readWindow(absolute, start, requested);
    if (window.binaryDetected) throw binaryRefusal(input.path, stats.size);

    const numbered = numberLines(window.lines, start);
    const notice = window.stoppedEarly ? "\n… [more lines follow; pass offset to continue]" : "";

    return toolOutput(`${numbered}${notice}`, {
      path: input.path,
      totalLines: null,
      returnedLines: window.lines.length,
      truncated: window.stoppedEarly,
      note: `file is ${stats.size} bytes; streamed without counting the total`,
    });
  },
};

/** Split on LF or CRLF, so both read paths agree on what a line is. */
function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

async function statFile(absolute: string, displayPath: string) {
  try {
    return await fs.stat(absolute);
  } catch (error) {
    throwFsError(error, displayPath);
  }
}

function binaryRefusal(displayPath: string, bytes: number): AgentError {
  return new AgentError(
    "invalid_tool",
    `refusing to read a binary file: ${displayPath} (${bytes} bytes). ` +
      "This tool reads text only; use ls to list and grep to search.",
  );
}

function numberLines(lines: readonly string[], start: number): string {
  const width = String(start + lines.length).length;
  return lines
    .map((line, index) => `${String(start + index + 1).padStart(width, " ")}  ${line}`)
    .join("\n");
}

interface LineWindow {
  lines: string[];
  /** True when reading stopped before the end of the file. */
  stoppedEarly: boolean;
  binaryDetected: boolean;
}

async function readWindow(absolute: string, start: number, count: number): Promise<LineWindow> {
  const stream = fsSync.createReadStream(absolute, { encoding: "utf8" });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const lines: string[] = [];
  let index = 0;
  let stoppedEarly = false;
  let binaryDetected = false;

  try {
    for await (const line of reader) {
      // The binary sniff has to happen here too: a file this large never reaches the
      // in-memory path where it would otherwise be checked.
      if (line.includes("\0")) {
        binaryDetected = true;
        break;
      }
      if (index >= start && lines.length < count) lines.push(line);
      index += 1;
      if (lines.length >= count) {
        stoppedEarly = true;
        break;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return { lines, stoppedEarly, binaryDetected };
}
