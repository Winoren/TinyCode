/**
 * Text shaping for the transcript.
 *
 * Tool results are untrusted input: they can be megabytes of build output or a
 * string that pretends to be a policy instruction. Everything entering the
 * transcript passes through here, so truncation is a Core property rather than
 * something each tool remembers to do.
 */

import { isToolOutput } from "./contracts.ts";

/** Hard ceiling for one transcript entry, in characters. */
export const MAX_TRANSCRIPT_CHARS = 8_000;

/** Render an arbitrary tool result as transcript text. Never throws. */
export function toTranscriptText(value: unknown): string {
  return truncate(render(value), MAX_TRANSCRIPT_CHARS);
}

function render(value: unknown): string {
  // A tool result carries model-facing text plus audit detail; the model gets only
  // the text. Any other value is rendered structurally.
  if (isToolOutput(value)) return value.content;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}\n… [truncated ${omitted} characters]`;
}
