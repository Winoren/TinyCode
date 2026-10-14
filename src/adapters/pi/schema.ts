/**
 * Schema bridging: zod (our single source of truth) → TypeBox (the model's view).
 *
 * The SDK validates `params` against `parameters` before calling `execute`, and our
 * registry validates again with zod. The Skill calls this the "two-channel" schema
 * rule. Keeping zod as the source means the model's view and our validation cannot
 * disagree about what a tool accepts.
 *
 * A malformed schema must never stop the runtime from starting, so conversion
 * failure degrades to a permissive object schema and reports a diagnostic instead
 * of throwing.
 */

import { Type, type TSchema } from "typebox";
import { z } from "zod";

export interface ParameterConversion {
  parameters: TSchema;
  /** Non-undefined when conversion failed and the permissive fallback was used. */
  error?: string;
}

const PERMISSIVE_FALLBACK: TSchema = Type.Unsafe({
  type: "object",
  properties: {},
  additionalProperties: true,
});

export function toParameters(schema: z.ZodType): ParameterConversion {
  try {
    const json = z.toJSONSchema(schema) as Record<string, unknown>;
    // Providers reject the `$schema` dialect marker; the SDK wants a bare schema.
    delete json.$schema;
    return { parameters: Type.Unsafe(json) };
  } catch (error) {
    return {
      parameters: PERMISSIVE_FALLBACK,
      error: `schema conversion failed, falling back to a permissive object: ${String(error)}`,
    };
  }
}
