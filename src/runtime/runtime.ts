/**
 * The Agent Runtime.
 *
 * The Runtime answers "how does a run actually happen and survive?"; it is
 * deliberately agnostic about which `RunDriver` produced the events, so the
 * deterministic Core loop and the Pi SDK adapter are interchangeable here.
 *
 * It owns every guarantee that makes a run trustworthy:
 *
 * 1. **Exactly one terminal event.** Whatever the driver does — returns early,
 *    throws, is cancelled, times out, fails retryably — the stream ends with one of
 *    `run_completed` / `run_failed` / `run_cancelled`, never zero and never two.
 * 2. **Monotonic `sequence`.** Minted only here, so replay ordering is a property
 *    of the system rather than a convention drivers must remember.
 * 3. **Cancellation is not a failure.** A fired caller signal ends the run as
 *    `run_cancelled`; a fired *timeout* ends it as `budget_timeout`. Conflating the
 *    two would tell the user they stopped something the clock actually killed.
 * 4. **Retry is visible and bounded.** A retryable failure schedules a retry and
 *    emits `retry_scheduled` rather than a terminal event, so the trace distinguishes
 *    a transient provider hiccup from a real failure. Cancellation is never retried.
 * 5. **Waiting for a human is a durable state.** `ask_human` moves the run to
 *    `awaiting_human`; the answer resumes it with an explicit `run_resumed`.
 * 6. **Persistence never blocks the loop.** Events are written fire-and-forget.
 */

import {
  DEFAULT_BUDGET,
  initialState,
  isTerminalEvent,
  RETRYABLE_ERROR_CODES,
  type AgentEvent,
  type AgentState,
  type EventDraft,
  type Run,
  type RunBudget,
  type RunError,
  type Session,
  type Task,
} from "../core/contracts.ts";
import { isAbortError, normalizeUnknownError } from "../core/errors.ts";
import type { DriverContext, HumanInputChannel, RunDriver } from "../core/loop.ts";
import { replayAgentState, type ReplayResult } from "../core/replay.ts";
import { EventRecorder } from "./recorder.ts";
import type { RunLog } from "./run-log.ts";
import type { SessionStore } from "./session-store.ts";

/**
 * Wait, unless the run is cancelled first. Resolves `false` when aborted, so callers
 * cannot accidentally treat a cancelled backoff as a successful sleep.
 */
export type Sleeper = (delayMs: number, signal: AbortSignal) => Promise<boolean>;

export interface AgentRuntimeOptions {
  /** Absolute workspace root handed to every tool. */
  cwd: string;
  driver: RunDriver;
  runLog: RunLog;
  sessionStore: SessionStore;
  budget?: RunBudget;
  /** Absent means an `ask_human` decision fails rather than proceeding. */
  humanInput?: HumanInputChannel;
  model?: string;
  now?: () => number;
  newId?: () => string;
  onPersistenceError?: (error: unknown) => void;
  /** Injectable so tests do not actually wait out a backoff. */
  sleep?: Sleeper;
}

export class AgentRuntime {
  readonly session: Session;

  private readonly cwd: string;
  private readonly driver: RunDriver;
  private readonly runLog: RunLog;
  private readonly sessionStore: SessionStore;
  private readonly budget: RunBudget;
  private readonly humanInput: HumanInputChannel | undefined;
  private readonly model: string | undefined;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly onPersistenceError: ((error: unknown) => void) | undefined;
  private readonly sleep: Sleeper;

  constructor(session: Session, options: AgentRuntimeOptions) {
    this.session = session;
    this.cwd = options.cwd;
    this.driver = options.driver;
    this.runLog = options.runLog;
    this.sessionStore = options.sessionStore;
    this.budget = options.budget ?? DEFAULT_BUDGET;
    this.humanInput = options.humanInput;
    this.model = options.model;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? defaultIdGenerator();
    this.onPersistenceError = options.onPersistenceError;
    this.sleep = options.sleep ?? sleepUnlessAborted;
  }

  /** Reconstruct a past run's state from its durable event log. */
  async recover(runId: string, task: Task): Promise<ReplayResult> {
    const events = await this.runLog.listEvents(runId);
    return replayAgentState(events, task);
  }

  /**
   * The state a run ended with, reconstructed from the log.
   * Exposed for the product surface and for tests asserting replay equivalence.
   */
  async finalState(runId: string, task: Task): Promise<AgentState> {
    const { state } = await this.recover(runId, task);
    return state;
  }

  async *run(task: Task, callerSignal?: AbortSignal): AsyncGenerator<AgentEvent, void, void> {
    const startedAt = this.now();
    const runId = this.newId();
    const run: Run = {
      runId,
      sessionId: this.session.id,
      task,
      status: "queued",
      startedAt,
      updatedAt: startedAt,
    };
    this.session.runs.push(run);
    await this.sessionStore.saveSession(this.session);

    const timeoutSignal = AbortSignal.timeout(this.budget.timeoutMs);
    const signal =
      callerSignal === undefined ? timeoutSignal : AbortSignal.any([callerSignal, timeoutSignal]);

    const recorder = new EventRecorder(runId, this.runLog, this.now, this.onPersistenceError);
    const state = initialState(task);

    let terminalKind: Run["status"] | undefined;
    let sawUsage = false;
    /** 1-based; incremented once per driver invocation. */
    let attempt = 0;

    const usageDraft = (): EventDraft => ({
      type: "usage_reported",
      usage: {
        toolCalls: state.toolCalls,
        durationMs: this.now() - startedAt,
        ...(this.model === undefined ? {} : { model: this.model }),
      },
    });

    /** A lifecycle record: worth persisting, never worth stalling the loop for. */
    const saveRunInBackground = (): void => {
      void this.runLog.saveRun({ ...run }).catch((error: unknown) => {
        this.onPersistenceError?.(error);
      });
    };

    const ctx: DriverContext = {
      budget: this.budget,
      signal,
      now: this.now,
      newToolCallId: () => this.newId(),
      humanInput: this.humanInput,
      model: this.model,
    };

    try {
      run.status = "running";
      run.updatedAt = this.now();
      await this.runLog.saveRun({ ...run });

      yield recorder.record({ type: "run_started" });

      while (terminalKind === undefined) {
        attempt += 1;
        let retryAfter: RunError | undefined;

        try {
          for await (const draft of this.driver(state, ctx)) {
            if (draft.type === "usage_reported") sawUsage = true;

            // Decide before recording: a retried attempt's failure must not enter the
            // log as a terminal event, or the run would appear to have failed twice.
            if (
              draft.type === "run_failed" &&
              RETRYABLE_ERROR_CODES.has(draft.error.code) &&
              attempt <= this.budget.maxRetries &&
              !signal.aborted
            ) {
              retryAfter = draft.error;
              break;
            }

            const event = recorder.record(draft);
            if (isTerminalEvent(event)) terminalKind = statusForTerminal(event.type);

            // Apply lifecycle transitions *before* handing the event out. `yield`
            // suspends this generator, so updating state afterwards means an observer
            // reacting to the event still sees the previous status.
            if (event.type === "human_input_requested") {
              run.status = "awaiting_human";
              run.updatedAt = this.now();
              saveRunInBackground();
            } else if (event.type === "human_input_received") {
              run.status = "running";
              run.updatedAt = this.now();
            }

            yield event;

            if (event.type === "human_input_received") {
              // Runtime-owned, like run_started: a lifecycle transition rather than
              // something a driver should be trusted to announce.
              yield recorder.record({ type: "run_resumed" });
            }
          }
        } catch (error) {
          // A fired signal is a lifecycle state, not a provider fault — and must not
          // be retried, even though `timeout` is a retryable provider code.
          if (isAbortError(error) || signal.aborted) {
            if (!sawUsage) yield recorder.record(usageDraft());
            if (timeoutSignal.aborted && callerSignal?.aborted !== true) {
              terminalKind = "failed";
              yield recorder.record({
                type: "run_failed",
                error: {
                  code: "budget_timeout",
                  message: `run exceeded the ${this.budget.timeoutMs}ms time budget`,
                },
              });
            } else {
              terminalKind = "cancelled";
              yield recorder.record({ type: "run_cancelled" });
            }
          } else {
            const runError = normalizeUnknownError(error);
            if (RETRYABLE_ERROR_CODES.has(runError.code) && attempt <= this.budget.maxRetries) {
              retryAfter = runError;
            } else {
              if (!sawUsage) yield recorder.record(usageDraft());
              terminalKind = "failed";
              yield recorder.record({ type: "run_failed", error: runError });
            }
          }
        }

        if (terminalKind !== undefined) break;

        if (retryAfter !== undefined) {
          const delayMs = backoffDelayMs(attempt);
          yield recorder.record({
            type: "retry_scheduled",
            attempt: attempt + 1,
            maxAttempts: this.budget.maxRetries + 1,
            delayMs,
            error: retryAfter,
          });

          const slept = await this.sleep(delayMs, signal);
          if (!slept) {
            // Cancelled or timed out during the backoff.
            if (!sawUsage) yield recorder.record(usageDraft());
            if (timeoutSignal.aborted && callerSignal?.aborted !== true) {
              terminalKind = "failed";
              yield recorder.record({
                type: "run_failed",
                error: {
                  code: "budget_timeout",
                  message: `run exceeded the ${this.budget.timeoutMs}ms time budget while backing off`,
                },
              });
            } else {
              terminalKind = "cancelled";
              yield recorder.record({ type: "run_cancelled" });
            }
          }
          continue;
        }

        // The driver stopped without saying how the run ended. Say it honestly.
        if (!sawUsage) yield recorder.record(usageDraft());
        const error: RunError =
          state.observations.length === 0
            ? {
                code: "no_progress",
                message: "run ended without a terminal event and produced no evidence",
              }
            : { code: "runtime_error", message: "run ended without a terminal event" };
        terminalKind = "failed";
        yield recorder.record({ type: "run_failed", error });
      }
    } finally {
      run.status = terminalKind ?? "failed";
      run.updatedAt = this.now();
      await this.runLog.saveRun({ ...run });
      await this.sessionStore.saveSession(this.session);
      await recorder.flush();
    }
  }
}

/**
 * Exponential backoff, capped. Deterministic on purpose: a jittered delay would make
 * the golden transcripts and the retry tests non-reproducible.
 */
export function backoffDelayMs(attempt: number, baseMs = 250, capMs = 4_000): number {
  const exponential = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, capMs);
}

function statusForTerminal(type: AgentEvent["type"]): Run["status"] {
  switch (type) {
    case "run_completed":
      return "completed";
    case "run_cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

const sleepUnlessAborted: Sleeper = (delayMs, signal) =>
  new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** Monotonic-enough ids without pulling in a uuid dependency. */
export function defaultIdGenerator(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${Date.now().toString(36)}-${counter.toString(36)}`;
  };
}

export async function createRuntime(
  options: AgentRuntimeOptions & { sessionStore: SessionStore },
): Promise<AgentRuntime> {
  const session = await options.sessionStore.createSession();
  return new AgentRuntime(session, options);
}
