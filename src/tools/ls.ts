/**
 * `ls` — list a directory.
 *
 * Directories carry a trailing slash so the model can tell a file from a folder
 * without a second call.
 */

import fs from "node:fs/promises";
import { z } from "zod";

import { AgentError, toolOutput } from "../core/contracts.ts";
import { resolveWithinWorkspace } from "./paths.ts";
import type { ToolDefinition } from "./types.ts";

const LsInput = z.object({
  path: z.string().optional().describe("Directory relative to the workspace root (default: root)"),
});

export type LsInput = z.infer<typeof LsInput>;

export const lsTool: ToolDefinition<LsInput> = {
  name: "ls",
  description: "List entries in a workspace directory. Subdirectories end with '/'.",

  schema: LsInput,

  async execute(input, ctx) {
    const requested = input.path ?? ".";
    const absolute = resolveWithinWorkspace(ctx.cwd, requested);

    let entries;
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new AgentError("invalid_tool", `directory not found: ${requested}`);
      if (code === "ENOTDIR") throw new AgentError("invalid_tool", `not a directory: ${requested}`);
      throw error;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    const names = entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    const body = names.length === 0 ? "(empty directory)" : names.join("\n");

    return toolOutput(body, {
      path: requested,
      count: names.length,
      directories: entries.filter((entry) => entry.isDirectory()).length,
    });
  },
};
