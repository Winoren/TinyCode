/**
 * The tool registry — the concrete `ToolPort`.
 *
 * This is the second of two independent gates on what the agent may do. The first is
 * the Core loop's allowlist check; this one refuses unknown names and malformed
 * arguments even if something bypasses the loop. Neither gate assumes the other ran.
 *
 * Argument validation happens here rather than inside each tool so that a malformed
 * call is a single, uniform `invalid_tool` observation instead of six different
 * error styles.
 */

import { AgentError, type ToolIntent, type ToolPort } from "../core/contracts.ts";
import type { AnyToolDefinition } from "./types.ts";

export interface ToolRegistryOptions {
  /** Absolute workspace root every tool is confined to. */
  cwd: string;
  /**
   * Environment handed to spawned processes. Supply a scrubbed copy: a command the
   * model wrote must not be able to read the agent's own provider credentials.
   */
  env?: NodeJS.ProcessEnv;
}

export function createToolRegistry(
  tools: readonly AnyToolDefinition[],
  options: ToolRegistryOptions,
): ToolPort {
  const byName = new Map<string, AnyToolDefinition>();
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    byName.set(tool.name, tool);
  }

  return {
    names: [...byName.keys()],

    async execute(intent: ToolIntent, signal: AbortSignal): Promise<unknown> {
      signal.throwIfAborted();

      const tool = byName.get(intent.name);
      if (tool === undefined) {
        throw new AgentError(
          "invalid_tool",
          `unknown tool: ${intent.name} (available: ${[...byName.keys()].join(", ")})`,
        );
      }

      const parsed = tool.schema.safeParse(intent.arguments);
      if (!parsed.success) {
        throw new AgentError(
          "invalid_tool",
          `invalid arguments for ${intent.name}: ${formatIssues(parsed.error.issues)}`,
        );
      }

      return tool.execute(parsed.data, {
        cwd: options.cwd,
        signal,
        ...(options.env === undefined ? {} : { env: options.env }),
      });
    },
  };
}

function formatIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
