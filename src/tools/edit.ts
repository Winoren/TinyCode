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
import { throwFsError } from "./fs-errors.ts";
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
      throwFsError(error, input.path);
    }

    // Exact match first: never rewrite text the model quoted verbatim.
    let needle = input.oldString;
    let replacement = input.newString;
    let adaptation = "exact";
    let occurrences = countOccurrences(original, needle);

    if (occurrences === 0) {
      // The model can only pass back what `read` showed it, and `read` normalises line
      // endings for display. Without this, every CRLF file — anything from a Windows
      // checkout — was uneditable, because the raw bytes never contained the text the
      // model was shown.
      const adapted = adaptToFileLineEndings(original, input.oldString, input.newString);
      const adaptedOccurrences = countOccurrences(original, adapted.oldString);
      if (adaptedOccurrences > 0) {
        needle = adapted.oldString;
        replacement = adapted.newString;
        adaptation = adapted.note;
        occurrences = adaptedOccurrences;
      }
    }

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
        ? original.split(needle).join(replacement)
        : original.replace(needle, replacement);

    try {
      await fs.writeFile(absolute, updated, "utf8");
    } catch (error) {
      throwFsError(error, input.path);
    }

    const replaced = input.replaceAll === true ? occurrences : 1;
    return toolOutput(`Replaced ${replaced} occurrence(s) in ${input.path}`, {
      path: input.path,
      replaced,
      occurrences,
      lineEndings: adaptation,
    });
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  return haystack.split(needle).length - 1;
}

/**
 * Adapt a quoted snippet to the file's own line endings.
 *
 * Only the needle and the replacement are converted; the rest of the file is left
 * byte-for-byte alone. Rewriting the whole file to a normalised form would turn a
 * one-token edit into a full-file diff, which is a much worse failure than the one
 * being fixed.
 */
function adaptToFileLineEndings(
  original: string,
  oldString: string,
  newString: string,
): { oldString: string; newString: string; note: string } {
  if (original.includes("\r\n") && !oldString.includes("\r\n")) {
    return {
      oldString: toCrlf(oldString),
      newString: toCrlf(newString),
      note: "adapted to CRLF",
    };
  }
  if (!original.includes("\r\n") && oldString.includes("\r\n")) {
    return {
      oldString: toLf(oldString),
      newString: toLf(newString),
      note: "adapted to LF",
    };
  }
  return { oldString, newString, note: "exact" };
}

/** Normalise first, so an already-converted string is not double-converted. */
function toCrlf(text: string): string {
  return toLf(text).replace(/\n/g, "\r\n");
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}
