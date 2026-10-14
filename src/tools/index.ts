/**
 * The tool set, and the two named allowlists a product actually chooses between.
 *
 * `READ_ONLY_TOOLS` is the inspection surface; `CODING_TOOLS` adds the mutating
 * tools. Making the distinction explicit means "give the agent read access" is a
 * selection, not a code change.
 */

import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";
import { readTool } from "./read.ts";
import type { AnyToolDefinition } from "./types.ts";
import { writeTool } from "./write.ts";

export { createToolRegistry } from "./registry.ts";
export type { AnyToolDefinition, ToolContext, ToolDefinition } from "./types.ts";

/** Inspection only — cannot change the workspace. */
export const READ_ONLY_TOOLS: readonly AnyToolDefinition[] = [readTool, lsTool, grepTool];

/**
 * The full coding surface.
 *
 * `bash` is included because this is a coding agent, but it is also the tool a
 * product would gate behind confirmation; that gate belongs to the Runtime, not
 * here.
 */
export const CODING_TOOLS: readonly AnyToolDefinition[] = [
  readTool,
  writeTool,
  editTool,
  lsTool,
  grepTool,
  bashTool,
];

/** Select tools by name. An unknown name is a programming error, not a runtime one. */
export function selectTools(
  names: readonly string[],
  available: readonly AnyToolDefinition[] = CODING_TOOLS,
): AnyToolDefinition[] {
  const byName = new Map(available.map((tool) => [tool.name, tool]));
  return names.map((name) => {
    const tool = byName.get(name);
    if (tool === undefined) {
      throw new Error(`unknown tool: ${name} (available: ${[...byName.keys()].join(", ")})`);
    }
    return tool;
  });
}

/**
 * Render the tool surface for a system prompt.
 *
 * Derived from the definitions rather than hand-written, so the prompt cannot
 * advertise a tool that does not exist or miss one that does.
 */
export function describeTools(tools: readonly AnyToolDefinition[]): string {
  return tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
}
