/**
 * The deterministic Core loop.
 *
 * This is the semantic reference implementation of the Skill's minimal loop:
 *
 *   Task → Context → Model decision → Tool action → Observation → State update → Result
 *
 * It runs against `ModelPort` / `ToolPort` only, so it needs no process, network,
 * database, or UI, and it emits the same product-level `EventDraft` vocabulary the
 * real Pi adapter emits. That shared vocabulary is what makes the golden-transcript
 * comparison between the fake path and the real path meaningful.
 *
 * A driver yields *drafts*; the Runtime owns the durable envelope (runId /
 * sequence / timestamp) and persistence. Raw SDK events never appear here.
 */

import {
  AgentError,
  type AgentEvent,
  type AgentState,
  type EventDraft,
  type ModelPort,
  type Observation,
  type RunBudget,
  type ToolPort,
} from "./contracts.ts";
import { assertWithinBudget } from "./budget.ts";
import { normalizeUnknownError } from "./errors.ts";
import {
  assistantIntentEntry,
  assistantReplyEntry,
  humanReplyEntry,
  toolResultEntry,
} from "./transcript.ts";

/** Ask a person something and resolve with their answer. Injected, never invented. */
export type HumanInputChannel = (question: string, signal: AbortSignal) => Promise<unknown>;

export interface DriverContext {
  budget: RunBudget;
  signal: AbortSignal;
  now: () => number;
  newToolCallId: () => string;
  /** Absent means `ask_human` must fail rather than silently proceed. */
  humanInput: HumanInputChannel | undefined;
  model: string | undefined;
}

export type RunDriver = (
  state: AgentState,
  ctx: DriverContext,
) => AsyncGenerator<EventDraft, void, void>;

export interface CoreLoopDeps {
  model: ModelPort;
  tools: ToolPort;
}

/**
 * The no-progress guard lives in the Runtime, not here: this loop cannot spin,
 * because every branch either terminates, records an observation, or completes a
 * human round trip. An SDK-driven loop *can* spin, and that is where the guard
 * earns its place. See `runtime.ts` — a driver that ends without a terminal event
 * is classified `no_progress` when it also produced no evidence.
 */
export function coreLoopDriver(deps: CoreLoopDeps): RunDriver {
  const allowed = new Set(deps.tools.names);

  return async function* coreLoop(state, ctx) {
    const startedAt = ctx.now();
    /** Tool names the run could not use. Drives complete-vs-partial at the end. */
    const missing = new Set<string>();

    for (;;) {
      ctx.signal.throwIfAborted();
      assertWithinBudget(
        ctx.budget,
        { iterations: state.iteration, toolCalls: state.toolCalls, startedAt },
        ctx.now(),
      );

      yield { type: "model_requested", ...(ctx.model === undefined ? {} : { model: ctx.model }) };
      const decision = await deps.model.decide(state, ctx.signal);
      yield { type: "decision_made", decision };

      if (decision.kind === "respond") {
        state.transcript.push(assistantReplyEntry(decision.content));
        yield { type: "usage_reported", usage: usageFor(state, ctx, startedAt) };
        yield {
          type: "run_completed",
          status: missing.size > 0 ? "partial" : "complete",
          result: decision.content,
          ...(missing.size > 0 ? { missingMaterial: [...missing].sort() } : {}),
        };
        return;
      }

      if (decision.kind === "ask_human") {
        if (ctx.humanInput === undefined) {
          throw new AgentError(
            "runtime_error",
            "ask_human without a human input channel: refusing to proceed silently",
          );
        }
        yield { type: "human_input_requested", question: decision.question };
        const input = await ctx.humanInput(decision.question, ctx.signal);
        yield { type: "human_input_received", input };
        state.iteration += 1;
        state.transcript.push(humanReplyEntry(input));
        continue;
      }

      // ---- call_tool ----
      const intent = decision.intent;
      // Recorded when decided, before the tool runs, so a crash mid-tool still
      // reconstructs the intent. Mirrors replay exactly.
      state.transcript.push(assistantIntentEntry(intent));

      if (!allowed.has(intent.name)) {
        // Security default: closed. An unknown tool is refused, and the refusal is
        // an absent capability, so it becomes missing material rather than a crash.
        missing.add(intent.name);
        const observation = recordObservation(state, intent.name, {
          ok: false,
          error: { code: "invalid_tool", message: `tool not in allowlist: ${intent.name}` },
          durationMs: 0,
          observedAt: ctx.now(),
        });
        yield { type: "observation_added", name: intent.name, observation };
        continue;
      }

      const toolCallId = ctx.newToolCallId();
      const toolStartedAt = ctx.now();
      yield { type: "tool_started", toolCallId, toolName: intent.name, args: intent.arguments };
      state.toolCalls += 1;

      try {
        const result = await deps.tools.execute(intent, ctx.signal);
        const durationMs = ctx.now() - toolStartedAt;
        yield {
          type: "tool_completed",
          toolCallId,
          toolName: intent.name,
          status: "success",
          result,
          durationMs,
        };
        const observation = recordObservation(state, intent.name, {
          ok: true,
          result,
          durationMs,
          observedAt: ctx.now(),
        });
        yield { type: "observation_added", name: intent.name, observation };
      } catch (error) {
        // Tool isolation: the failure lands only on this tool's observation.
        const runError = normalizeUnknownError(error);
        const durationMs = ctx.now() - toolStartedAt;
        yield {
          type: "tool_completed",
          toolCallId,
          toolName: intent.name,
          status: "error",
          error: runError,
          durationMs,
        };
        const observation = recordObservation(state, intent.name, {
          ok: false,
          error: { code: runError.code, message: runError.message },
          durationMs,
          observedAt: ctx.now(),
        });
        yield { type: "observation_added", name: intent.name, observation };
      }
    }
  };
}

/**
 * Append an observation and its transcript entry together.
 *
 * These two must never be written separately: the transcript is what the model
 * sees, the observation is what the auditor sees, and a run where they disagree is
 * neither inspectable nor replayable. One function keeps them in step.
 */
function recordObservation(
  state: AgentState,
  name: string,
  partial: Omit<Observation, "name">,
): Observation {
  const observation: Observation = { name, ...partial };
  state.observations.push(observation);
  state.transcript.push(toolResultEntry(name, observation));
  state.iteration += 1;
  return observation;
}

function usageFor(state: AgentState, ctx: DriverContext, startedAt: number) {
  return {
    toolCalls: state.toolCalls,
    durationMs: ctx.now() - startedAt,
    ...(ctx.model === undefined ? {} : { model: ctx.model }),
  };
}

/** Narrow a run's terminal event out of an event list. */
export function terminalOf(events: readonly AgentEvent[]): AgentEvent | undefined {
  return events.find(
    (event) =>
      event.type === "run_completed" ||
      event.type === "run_failed" ||
      event.type === "run_cancelled",
  );
}
