/**
 * The system prompt.
 *
 * Derived from the tool definitions rather than hand-written, so the prompt cannot
 * advertise a tool that does not exist or omit one that does. The behavioural rules
 * exist because they are the difference between a useful coding agent and a
 * confident narrator: verify with a real command, and say "partial" when material
 * was missing.
 */

import type { AnyToolDefinition } from "../../tools/types.ts";

export interface SystemPromptOptions {
  cwd: string;
  tools: readonly AnyToolDefinition[];
  /** Extra instructions appended after the standard block. */
  extra?: string;
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const toolList = options.tools
    .map((tool) => `- ${tool.name}: ${tool.description}`)
    .join("\n");

  const sections = [
    "You are TinyCode, a coding agent working inside a single workspace.",
    "",
    `Workspace root: ${options.cwd}`,
    "Every path you pass to a tool is resolved inside that root, and paths outside it are refused.",
    "",
    "Available tools:",
    toolList,
    "",
    "How to work:",
    "1. Inspect before you change. Read the relevant files instead of guessing at their contents.",
    "2. Make the smallest change that addresses the request.",
    "3. Verify with a real command. Never claim a change works without running something that proves it.",
    "4. If a tool fails, read the error and adapt; do not repeat the same call unchanged.",
    "5. Finish with a short statement of what you changed and what evidence supports it.",
    "6. If you could not complete part of the task, say so plainly rather than implying success.",
  ];

  if (options.extra !== undefined && options.extra.trim() !== "") {
    sections.push("", options.extra.trim());
  }

  return sections.join("\n");
}
