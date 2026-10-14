/**
 * `edit` — exact-string replacement.
 *
 * The safety property is uniqueness. A blind "replace the first match" silently
 * corrupts files when the target text appears in several places, so an ambiguous
 * match is refused and the model is told how many matches it hit. That refusal is a
 * visible, recoverable observation rather than a quiet wrong edit — which is the
 * whole reason a coding agent needs an `edit` tool instead of `write`.
 */

import fs from "node:fs/promises";
import { z } from "zod";

import { AgentError, toolOutput } from "../core/contracts.ts";
import { resolveWithinWorkspace } from "./paths.ts";
import type { ToolDefinition } from "./types.ts";

const EditInput = z.object({
  path: z.string().min(1).describe("File path relative to the workspace root"),
  oldString: z.string().min(1).describe("Exact text to replace"),
  newString: z.string().describe("Replacement text"),
  replaceAll: z
    .boolean()
    .optional()
    .describe("Replace every occurrence; required when the text is not unique"),
});

export type EditInput = z.infer<typeof EditInput>;

export const editTool: ToolDefinition<EditInput> = {
  name: "edit",
  description:
    "Replace an exact string in a file. The text must appear exactly once unless " +
    "replaceAll is true; an ambiguous match is refused rather than guessed.",

  schema: EditInput,

  async execute(input, ctx) {
    const absolute = resolveWithinWorkspace(ctx.cwd, input.path);

    let original: string;
    try {
      original = await fs.readFile(absolute, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AgentError("invalid_tool", `file not found: ${input.path}`);
      }
      throw error;
    }

    const occurrences = countOccurrences(original, input.oldString);

    if (occurrences === 0) {
      throw new AgentError(
        "invalid_tool",
        `oldString not found in ${input.path}; read the file and copy the exact text`,
      );
    }
    if (occurrences > 1 && input.replaceAll !== true) {
      throw new AgentError(
        "invalid_tool",
        `oldString appears ${occurrences} times in ${input.path}; ` +
          "include more surrounding context to make it unique, or pass replaceAll: true",
      );
    }

    const updated =
      input.replaceAll === true
        ? original.split(input.oldString).join(input.newString)
        : original.replace(input.oldString, input.newString);

    await fs.writeFile(absolute, updated, "utf8");

    const replaced = input.replaceAll === true ? occurrences : 1;
    return toolOutput(`Replaced ${replaced} occurrence(s) in ${input.path}`, {
      path: input.path,
      replaced,
      occurrences,
    });
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  return haystack.split(needle).length - 1;
}
