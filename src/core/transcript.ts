/**
 * Transcript construction — the single implementation.
 *
 * The live loop and the replay path must produce byte-identical AgentState, or the
 * event log is not a recovery mechanism. Both call these helpers instead of each
 * building entries by hand, so the two paths cannot drift.
 *
 * (This was a real defect: the first version of the loop recorded observations but
 * never wrote their transcript entries, so the model could not see tool results and
 * replay disagreed with live state. Sharing one constructor removes the class.)
 */

import type { Observation, ToolIntent, TranscriptEntry } from "./contracts.ts";
import { toTranscriptText } from "./text.ts";

/** The assistant's intent, recorded when the decision is made. */
export function assistantIntentEntry(intent: ToolIntent): TranscriptEntry {
  return { role: "assistant", text: "", intent };
}

/** The assistant's final answer. */
export function assistantReplyEntry(content: string): TranscriptEntry {
  return { role: "assistant", text: content };
}

/** A person's answer to an `ask_human` question. */
export function humanReplyEntry(input: unknown): TranscriptEntry {
  return { role: "user", text: toTranscriptText(input) };
}

/**
 * The tool's observable result, rendered for the model.
 *
 * Tool output is untrusted: `toTranscriptText` truncates it before it can crowd
 * out the conversation or smuggle in an instruction-shaped payload.
 */
export function toolResultEntry(name: string, observation: Observation): TranscriptEntry {
  return {
    role: "tool",
    name,
    text: observation.ok
      ? toTranscriptText(observation.result)
      : observation.error?.message ?? "tool failed",
    ok: observation.ok,
  };
}
