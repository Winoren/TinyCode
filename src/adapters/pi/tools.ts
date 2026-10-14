/**
 * Tool bridging: our `ToolPort` → the SDK's `defineTool`.
 *
 * The SDK's `execute` takes five arguments and returns `{ content, details }`; ours
 * takes an intent and a signal. This module is the only place that knows both
 * shapes, so no SDK tool object leaks into the Core or the tool implementations.
 *
 * Verified against the installed types (see docs/adapter-mapping.md §2.2): the real
 * signature is
 *   execute(toolCallId, params, signal, onUpdate, ctx)
 * — five parameters, not the three the Skill's snippets show.
 */

import {
  defineTool,
  type ToolDefinition as PiToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { isToolOutput, type ToolPort } from "../../core/contracts.ts";
import { toTranscriptText } from "../../core/text.ts";
import type { AnyToolDefinition } from "../../tools/types.ts";
import { toParameters } from "./schema.ts";

export interface PiToolBridge {
  tools: PiToolDefinition[];
  /** Non-empty when a tool schema could not be converted. Surfaced, never swallowed. */
  diagnostics: string[];
}

export function definePiTools(
  definitions: readonly AnyToolDefinition[],
  port: ToolPort,
): PiToolBridge {
  const diagnostics: string[] = [];

  const tools = definitions.map((definition) => {
    const { parameters, error } = toParameters(definition.schema);
    if (error !== undefined) diagnostics.push(`${definition.name}: ${error}`);

    return defineTool({
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters,

      // Second validation channel, on the execution side.
      prepareArguments: (args: unknown) => definition.schema.parse(args) as never,

      execute: async (
        _toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
      ) => {
        // The SDK may pass `undefined`; our ToolPort requires a real signal.
        const effectiveSignal = signal ?? new AbortController().signal;
        const result = await port.execute(
          { name: definition.name, arguments: (params ?? {}) as Record<string, unknown> },
          effectiveSignal,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: isToolOutput(result) ? result.content : toTranscriptText(result),
            },
          ],
          details: isToolOutput(result) ? result.details : result,
        };
      },
    });
  });

  return { tools, diagnostics };
}
