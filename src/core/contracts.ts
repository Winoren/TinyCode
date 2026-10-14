/**
 * TinyCode Core contracts.
 *
 * Pure domain types only: no SDK imports, no filesystem, no network, no timers,
 * no globals. The Core answers one question — "what does a valid Agent run mean?"
 * The Runtime (../runtime) answers "how does a run actually happen and survive?"
 *
 * Every type here protects one first-principles distinction: what the Agent must
 * know, what it may do, what it observed, and how the run ends.
 */

// ---------------------------------------------------------------- task & state

/** The real unit of work: a person's request, plus the directory it applies to. */
export interface Task {
  id: string;
  input: string;
  cwd: string;
}

/** A request to act. Atomic: one tool, one argument object. */
export interface ToolIntent {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * What the model decided to do next.
 *
 * `ask_human` exists so that "a dangerous action needs a person" is a Core
 * semantic rather than an SDK extension side effect.
 */
export type Decision =
  | { kind: "respond"; content: string }
  | { kind: "call_tool"; intent: ToolIntent }
  | { kind: "ask_human"; question: string };

/**
 * Structured evidence that an action happened, with its provenance.
 * Observations are ordered history, not a name-keyed map: the same tool may run
 * many times in a run, and losing the ordering loses the audit trail.
 */
export interface Observation {
  name: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  durationMs: number;
  observedAt: number;
}

/** The conversation the model sees. Separate from observations on purpose. */
export type TranscriptEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; intent?: ToolIntent }
  | { role: "tool"; name: string; text: string; ok: boolean };

/** Everything the model needs to decide the next step. Survives a restart via replay. */
export interface AgentState {
  task: Task;
  transcript: TranscriptEntry[];
  observations: Observation[];
  iteration: number;
  toolCalls: number;
}

/** A blank state for a fresh run. The only legal way to start. */
export function initialState(task: Task): AgentState {
  return {
    task,
    transcript: [{ role: "user", text: task.input }],
    observations: [],
    iteration: 0,
    toolCalls: 0,
  };
}

// ---------------------------------------------------------------- run lifecycle

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_human"
  | "completed"
  | "failed"
  | "cancelled";

export interface Run {
  runId: string;
  sessionId: string;
  task: Task;
  status: RunStatus;
  startedAt: number;
  updatedAt: number;
}

export interface Session {
  id: string;
  createdAt: number;
  runs: Run[];
}

/**
 * The complete failure taxonomy. Anything the Runtime cannot classify becomes
 * `runtime_error`; nothing is allowed to escape untyped.
 *
 * Retryable: rate_limited | timeout | provider_unavailable
 * Not retryable: auth | invalid_tool | runtime_error | budget_* | no_progress
 */
export type RunErrorCode =
  | "budget_iterations"
  | "budget_tools"
  | "budget_timeout"
  | "no_progress"
  | "rate_limited"
  | "timeout"
  | "auth"
  | "invalid_tool"
  | "provider_unavailable"
  | "runtime_error";

export const RETRYABLE_ERROR_CODES: ReadonlySet<RunErrorCode> = new Set<RunErrorCode>([
  "rate_limited",
  "timeout",
  "provider_unavailable",
]);

export interface RunError {
  code: RunErrorCode;
  message: string;
}

// ---------------------------------------------------------------- events

export interface UsageReport {
  inputTokens?: number;
  outputTokens?: number;
  /** Provider-reported cost, when the provider reports it. */
  costUSD?: number;
  toolCalls: number;
  durationMs: number;
  model?: string;
}

/**
 * Product-level events. Raw SDK callbacks never cross this boundary — this union
 * is the only contract the CLI, trace writer, and tests consume.
 *
 * `EventDraft` omits the runtime-assigned envelope (runId/sequence/timestamp) so
 * emitters cannot invent their own ordering.
 */
export type EventDraft =
  | { type: "run_started" }
  | { type: "model_requested"; model?: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "decision_made"; decision: Decision }
  | { type: "tool_started"; toolCallId: string; toolName: string; args?: unknown }
  | {
      type: "tool_completed";
      toolCallId: string;
      toolName: string;
      status: "success" | "error";
      result?: unknown;
      error?: RunError;
      durationMs: number;
    }
  | { type: "observation_added"; name: string; observation: Observation }
  | { type: "human_input_requested"; question: string }
  | { type: "human_input_received"; input: unknown }
  | { type: "usage_reported"; usage: UsageReport }
  | {
      type: "run_completed";
      status: "complete" | "partial";
      result: string;
      missingMaterial?: string[];
    }
  | { type: "run_failed"; error: RunError }
  | { type: "run_cancelled" }
  | { type: "run_resumed" };

/** A durable event: the draft plus its monotonic envelope. */
export type AgentEvent = EventDraft & {
  runId: string;
  sequence: number;
  timestamp: number;
};

export type AgentEventType = AgentEvent["type"];

export const TERMINAL_EVENT_TYPES: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  "run_completed",
  "run_failed",
  "run_cancelled",
]);

export function isTerminalEvent(event: AgentEvent): boolean {
  return TERMINAL_EVENT_TYPES.has(event.type);
}

// ---------------------------------------------------------------- ports

/**
 * The seam the Core decides through. The Runtime supplies an adapter; the Core
 * never learns which provider answered.
 */
export interface ModelPort {
  decide(state: AgentState, signal: AbortSignal): Promise<Decision>;
}

/**
 * The seam the Core acts through. Implementations must reject in-flight work
 * when `signal` fires, and must refuse names outside the allowlist.
 */
export interface ToolPort {
  readonly names: readonly string[];
  execute(intent: ToolIntent, signal: AbortSignal): Promise<unknown>;
}

// ---------------------------------------------------------------- budgets

/**
 * A run terminates predictably or it is not a Runtime.
 * The Runtime checks the budget; the Core never does.
 */
export interface RunBudget {
  maxIterations: number;
  maxToolCalls: number;
  maxRetries: number;
  timeoutMs: number;
}

export const DEFAULT_BUDGET: RunBudget = {
  maxIterations: 24,
  maxToolCalls: 64,
  maxRetries: 2,
  timeoutMs: 300_000,
};

// ---------------------------------------------------------------- errors

export class AgentError extends Error {
  readonly code: RunErrorCode;

  constructor(code: RunErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "AgentError";
    this.code = code;
  }

  toRunError(): RunError {
    return { code: this.code, message: this.message };
  }
}

/** A run that cannot be bought back by retrying. */
export class BudgetExceededError extends AgentError {
  constructor(code: "budget_iterations" | "budget_tools" | "budget_timeout", message: string) {
    super(code, message);
    this.name = "BudgetExceededError";
  }
}
