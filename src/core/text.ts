/**
 * Text shaping for the transcript.
 *
 * Tool results are untrusted input: they can be megabytes of build output or a
 * string that pretends to be a policy instruction. Everything entering the
 * transcript passes through here, so truncation is a Core property rather than
 * something each tool remembers to do.
 */

/** Hard ceiling for one transcript entry, in characters. */
export const MAX_TRANSCRIPT_CHARS = 8_000;

/** Render an arbitrary tool result as transcript text. Never throws. */
export function toTranscriptText(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return truncate(text, MAX_TRANSCRIPT_CHARS);
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}\n… [truncated ${omitted} characters]`;
}
