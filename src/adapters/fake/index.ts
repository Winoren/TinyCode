/**
 * Fake adapters.
 *
 * These exist so the Core loop can be proven without a process, network, or SDK.
 * They are not test doubles in the mocking sense: they implement the same ports
 * the real adapter implements, with deterministic, inspectable behavior.
 */

import type {
  AgentState,
  Decision,
  ModelPort,
  ToolIntent,
  ToolPort,
} from "../../core/contracts.ts";

/** A scripted model. Returns the given decisions in order, then throws if asked again. */
export function scriptedModel(decisions: readonly Decision[]): ModelPort & { calls: number } {
  let index = 0;
  const port: ModelPort & { calls: number } = {
    calls: 0,
    async decide(_state: AgentState, _signal: AbortSignal): Promise<Decision> {
      port.calls += 1;
      const decision = decisions[index];
      index += 1;
      if (decision === undefined) {
        throw new Error(`scriptedModel exhausted after ${decisions.length} decisions`);
      }
      return decision;
    },
  };
  return port;
}

/** A model that decides from a function of the current state. */
export function functionalModel(
  decide: (state: AgentState, signal: AbortSignal) => Promise<Decision> | Decision,
): ModelPort {
  return {
    async decide(state, signal) {
      return decide(state, signal);
    },
  };
}

export interface RecordingTool {
  /** Every intent the tool saw, in order. */
  readonly seen: ToolIntent[];
}

/**
 * A tool registry with deterministic responses.
 *
 * `handlers` maps a tool name to either a value (resolved result) or a function.
 * Throwing from a handler is how tool failure is simulated.
 */
export function fakeTools(handlers: Record<string, (intent: ToolIntent) => unknown>): ToolPort & RecordingTool {
  const seen: ToolIntent[] = [];
  const names = Object.keys(handlers);
  return {
    names,
    seen,
    async execute(intent: ToolIntent, signal: AbortSignal): Promise<unknown> {
      signal.throwIfAborted();
      const handler = handlers[intent.name];
      if (handler === undefined) throw new Error(`no such tool: ${intent.name}`);
      seen.push(intent);
      return handler(intent);
    },
  };
}
