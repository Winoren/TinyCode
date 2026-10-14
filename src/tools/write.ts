/**
 * `write` — create or overwrite a file.
 *
 * Reported as a byte count rather than by echoing the content back: echoing would
 * double the context cost of every write for no new information.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { toolOutput } from "../core/contracts.ts";
import { throwFsError } from "./fs-errors.ts";
import { resolveWithinWorkspace } from "./paths.ts";
import type { ToolDefinition } from "./types.ts";

const WriteInput = z.object({
  path: z.string().min(1).describe("File path relative to the workspace root"),
  content: z.string().describe("Full file content to write"),
});

export type WriteInput = z.infer<typeof WriteInput>;

export const writeTool: ToolDefinition<WriteInput> = {
  name: "write",
  description:
    "Write a file inside the workspace, creating parent directories as needed. " +
    "Overwrites any existing file. Prefer edit for small changes to existing files.",

  schema: WriteInput,

  async execute(input, ctx) {
    const absolute = resolveWithinWorkspace(ctx.cwd, input.path);

    let existed: boolean;
    try {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      existed = await fileExists(absolute);
      await fs.writeFile(absolute, input.content, "utf8");
    } catch (error) {
      // A path that is a directory, or whose parent is a file, is a shape error the
      // model can correct — not an internal failure.
      throwFsError(error, input.path);
    }

    const bytes = Buffer.byteLength(input.content, "utf8");

    return toolOutput(`${existed ? "Overwrote" : "Created"} ${input.path} (${bytes} bytes)`, {
      path: input.path,
      bytes,
      created: !existed,
    });
  },
};

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
