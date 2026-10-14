/**
 * Budget enforcement and the no-progress guard.
 *
 * Pure functions over run counters, deliberately separate from the Runtime so the
 * termination rules can be tested without executing anything.
 */

import { BudgetExceededError, type RunBudget } from "./contracts.ts";

export interface BudgetCounters {
  /**
   * Model turns taken so far. Deliberately *not* `AgentState.iteration`, which counts
   * productive steps (observations and human round trips) and is what replay
   * reconstructs. Conflating the two made the final answering turn run out of budget:
   * a run with N tool calls had `iteration === N`, so it needed N+1 turns but was
   * stopped at N.
   */
  turns: number;
  toolCalls: number;
  startedAt: number;
}

/** The budget check the Runtime performs *before* each iteration. */
export function assertWithinBudget(
  budget: RunBudget,
  counters: BudgetCounters,
  now: number,
): void {
  if (counters.turns >= budget.maxIterations) {
    throw new BudgetExceededError(
      "budget_iterations",
      `iteration budget exhausted (${budget.maxIterations} model turns)`,
    );
  }
  if (counters.toolCalls > budget.maxToolCalls) {
    throw new BudgetExceededError(
      "budget_tools",
      `tool budget exhausted (${budget.maxToolCalls})`,
    );
  }
  const elapsed = now - counters.startedAt;
  if (elapsed >= budget.timeoutMs) {
    throw new BudgetExceededError(
      "budget_timeout",
      `time budget exhausted (${budget.timeoutMs}ms, elapsed ${elapsed}ms)`,
    );
  }
}

/**
 * The no-progress guard.
 *
 * An iteration that produced neither an observation nor a human-input round trip
 * is a spin. A model that keeps answering "let me think" without acting must not
 * burn the whole budget, and the run must say `no_progress` rather than pretend
 * it finished.
 *
 * Returns true when the iteration made progress.
 */
export function madeProgress(input: {
  observationsBefore: number;
  observationsAfter: number;
  humanRoundTrip: boolean;
}): boolean {
  return input.observationsAfter > input.observationsBefore || input.humanRoundTrip;
}
