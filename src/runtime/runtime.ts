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
 *    throws, is cancelled, times out — the stream ends with one of
 *    `run_completed` / `run_failed` / `run_cancelled`, never zero and never two.
 * 2. **Monotonic `sequence`.** Minted only here, so replay ordering is a property
 *    of the system rather than a convention drivers must remember.
 * 3. **Cancellation is not a failure.** A fired caller signal ends the run as
 *    `run_cancelled`; a fired *timeout* ends it as `budget_timeout`. Conflating the
 *    two would tell the user they stopped something the clock actually killed.
 * 4. **The no-progress guard.** A driver that stops without a terminal event is
 *    classified `no_progress` when it also produced no evidence, instead of being
 *    reported as a successful run that quietly did nothing.
 * 5. **Persistence never blocks the loop.** Events are written fire-and-forget.
 */

import {
  DEFAULT_BUDGET,
  initialState,
  isTerminalEvent,
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
  }

  /** Reconstruct a past run's state from its durable event log. */
  async recover(runId: string, task: Task): Promise<ReplayResult> {
    const events = await this.runLog.listEvents(runId);
    return replayAgentState(events, task);
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

    const recorder = new EventRecorder(
      runId,
      this.runLog,
      this.now,
      this.onPersistenceError,
    );
    const state = initialState(task);

    let terminalKind: Run["status"] | undefined;
    let sawUsage = false;

    const usageDraft = (): EventDraft => ({
      type: "usage_reported",
      usage: {
        toolCalls: state.toolCalls,
        durationMs: this.now() - startedAt,
        ...(this.model === undefined ? {} : { model: this.model }),
      },
    });

    try {
      run.status = "running";
      run.updatedAt = this.now();
      await this.runLog.saveRun(run);

      yield recorder.record({ type: "run_started" });

      const ctx: DriverContext = {
        budget: this.budget,
        signal,
        now: this.now,
        newToolCallId: () => this.newId(),
        humanInput: this.humanInput,
        model: this.model,
      };

      for await (const draft of this.driver(state, ctx)) {
        if (draft.type === "usage_reported") sawUsage = true;
        const event = recorder.record(draft);
        if (isTerminalEvent(event)) {
          terminalKind = statusForTerminal(event.type);
        }
        yield event;
      }

      if (terminalKind === undefined) {
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
    } catch (error) {
      if (terminalKind === undefined) {
        if (!sawUsage) yield recorder.record(usageDraft());

        const callerCancelled = callerSignal?.aborted === true;
        if (timeoutSignal.aborted && !callerCancelled) {
          terminalKind = "failed";
          yield recorder.record({
            type: "run_failed",
            error: {
              code: "budget_timeout",
              message: `run exceeded the ${this.budget.timeoutMs}ms time budget`,
            },
          });
        } else if (callerCancelled || isAbortError(error)) {
          terminalKind = "cancelled";
          yield recorder.record({ type: "run_cancelled" });
        } else {
          terminalKind = "failed";
          yield recorder.record({ type: "run_failed", error: normalizeUnknownError(error) });
        }
      }
    } finally {
      run.status = terminalKind ?? "failed";
      run.updatedAt = this.now();
      await this.runLog.saveRun(run);
      await this.sessionStore.saveSession(this.session);
      await recorder.flush();
    }
  }

  /**
   * The state a run ended with, reconstructed from the log.
   * Exposed for the product surface and for tests asserting replay equivalence.
   */
  async finalState(runId: string, task: Task): Promise<AgentState> {
    const { state } = await this.recover(runId, task);
    return state;
  }
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

/** Monotonic-enough ids without pulling in a uuid dependency. */
function defaultIdGenerator(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${Date.now().toString(36)}-${counter.toString(36)}`;
  };
}

export interface CreateRuntimeOptions extends Omit<AgentRuntimeOptions, "sessionStore"> {
  sessionStore: SessionStore;
}

export async function createRuntime(options: CreateRuntimeOptions): Promise<AgentRuntime> {
  const session = await options.sessionStore.createSession();
  return new AgentRuntime(session, options);
}
