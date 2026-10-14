/**
 * Event-log replay.
 *
 * The append-only event log is the source of truth; a snapshot is only a cache.
 * Replaying a run's events in `sequence` order must rebuild the exact AgentState
 * the run held in memory — otherwise the log is not an audit trail, it is a
 * summary, and a crash cannot be recovered from.
 *
 * This module is deliberately pure and knows nothing about storage, so the same
 * function serves recovery, testing, and post-hoc inspection.
 *
 * Transcript entries are built by `./transcript.ts`, the same helpers the live loop
 * uses, so replay and live state cannot drift apart.
 */

import { initialState, type AgentEvent, type AgentState, type Task } from "./contracts.ts";
import {
  assistantIntentEntry,
  assistantReplyEntry,
  humanReplyEntry,
  toolResultEntry,
} from "./transcript.ts";

export interface ReplayResult {
  state: AgentState;
  /** The terminal event, if the log contains one. Absence means the run was cut short. */
  terminal?: AgentEvent;
}

export function replayAgentState(events: readonly AgentEvent[], task: Task): ReplayResult {
  const state = initialState(task);
  let terminal: AgentEvent | undefined;

  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);

  for (const event of ordered) {
    switch (event.type) {
      case "decision_made": {
        const decision = event.decision;
        if (decision.kind === "call_tool") {
          state.transcript.push(assistantIntentEntry(decision.intent));
        } else if (decision.kind === "respond") {
          state.transcript.push(assistantReplyEntry(decision.content));
        }
        // `ask_human` records no assistant entry: the question is its own event,
        // and the human's answer is the next transcript entry.
        break;
      }

      case "tool_started": {
        // The anchor for "a tool actually began executing". Refused or unknown
        // tools never emit this, which is why the tool budget counts here.
        state.toolCalls += 1;
        break;
      }

      case "observation_added": {
        const observation = event.observation;
        state.observations.push(observation);
        state.transcript.push(toolResultEntry(event.name, observation));
        state.iteration += 1;
        break;
      }

      case "human_input_received": {
        state.iteration += 1;
        state.transcript.push(humanReplyEntry(event.input));
        break;
      }

      case "run_completed":
      case "run_failed":
      case "run_cancelled": {
        terminal = event;
        break;
      }

      // run_started / run_resumed / model_requested / text_delta / thinking_delta /
      // tool_completed / human_input_requested / usage_reported carry no state that
      // is not already reconstructed by the events above.
      default:
        break;
    }
  }

  return terminal === undefined ? { state } : { state, terminal };
}
