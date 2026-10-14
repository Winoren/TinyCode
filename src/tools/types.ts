/**
 * The tool contract.
 *
 * A tool is a named capability with a validated input and a two-audience output.
 * Keeping the schema next to the implementation means the model's view of the tool
 * and the tool's actual validation cannot drift.
 */

import type { ZodType } from "zod";

import type { ToolOutput } from "../core/contracts.ts";

export interface ToolContext {
  /** Absolute workspace root. Every path a tool touches is resolved against it. */
  cwd: string;
  signal: AbortSignal;
}

export interface ToolDefinition<Input> {
  name: string;
  description: string;
  /** Validated at the boundary, so a tool body can trust its input. */
  schema: ZodType<Input>;
  execute(input: Input, ctx: ToolContext): Promise<ToolOutput>;
}

/**
 * Type-erased tool, for holding heterogeneous tools in one registry.
 *
 * `ToolDefinition<Input>` is contravariant in `Input`, so a mixed list genuinely
 * cannot be typed as `ToolDefinition<unknown>[]`. `any` appears here at exactly one
 * boundary and is never trusted: the registry runs `schema.safeParse` before
 * calling `execute`, so the erased type is only a storage detail.
 */
export interface AnyToolDefinition {
  name: string;
  description: string;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  schema: ZodType<any>;
  execute(input: any, ctx: ToolContext): Promise<ToolOutput>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
