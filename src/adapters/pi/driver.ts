/**
 * The Pi Agent SDK driver.
 *
 * The SDK runs its *own* agent loop: `session.prompt()` drives model turns and
 * reports a stream of events. We do not fight that; we normalize it. Every SDK event
 * is translated into the same `EventDraft` vocabulary the deterministic Core loop
 * emits, and the AgentState is mutated through the same shared helpers
 * (`transcript.ts`), so the fake path and the real path mean the same thing.
 *
 * The translation itself lives in `./normalize.ts` as a pure function, so the
 * SDK-coupled logic has tests rather than only a live-provider path.
 *
 * Three SDK facts this file is built around, all verified against 0.84.2 rather than
 * assumed (see docs/adapter-mapping.md):
 *
 * 1. `agent_end` is **not** the end. It carries `willRetry`, so a retry follows. The
 *    turn ends when `prompt()` settles.
 * 2. `execute` takes five parameters; `signal` is third from last and may be
 *    `undefined`.
 * 3. `tools` is an explicit allowlist. Passing our tool names makes the registry and
 *    the active set exactly our tools — which matters because our tool names collide
 *    with pi's built-ins, and a surviving built-in `bash` would bypass the workspace
 *    boundary in `tools/paths.ts` entirely.
 */

import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

import {
  AgentError,
  BudgetExceededError,
  type EventDraft,
  type ToolPort,
} from "../../core/contracts.ts";
import { createGatedToolPort, type GatePolicy } from "../../core/gate.ts";
import type { HumanInputChannel } from "../../core/contracts.ts";
import type { RunDriver } from "../../core/loop.ts";
import { assistantReplyEntry } from "../../core/transcript.ts";
import type { AnyToolDefinition } from "../../tools/types.ts";
import {
  classifyErrorStop,
  createNormalizationScratch,
  finalAnswerText,
  normalizeSessionEvent,
  toUsageReport,
  type SessionEvent,
} from "./normalize.ts";
import { definePiTools } from "./tools.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

type SessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;

export interface PiSessionPlan {
  sessionOptions: SessionOptions;
  /** Non-empty when a tool schema could not be converted to a model-facing schema. */
  diagnostics: string[];
}

export interface PiDriverOptions {
  cwd: string;
  /** Omitted means the SDK resolves a model from settings/first available. */
  model?: NonNullable<SessionOptions["model"]>;
  modelRuntime?: SessionOptions["modelRuntime"];
  agentDir?: string;
  thinkingLevel?: NonNullable<SessionOptions["thinkingLevel"]>;
  /**
   * Provider-level retry budget handed to the SDK. The Runtime also retries, but the
   * SDK can retry a single request without discarding the conversation, so both
   * layers are configured from the same number rather than one being hardcoded.
   */
  maxRetries?: number;
  /** Our tool implementations. */
  toolPort: ToolPort;
  /** The tools we intend to expose; also becomes the SDK allowlist. */
  tools: readonly AnyToolDefinition[];
  systemPrompt?: string;
  /**
   * Confirmation policy. Wired as a `ToolPort` decorator, because both execution paths
   * funnel through `ToolPort.execute` — so this is the one place a gate holds on the
   * SDK path, where the model emits tool calls rather than Core `ask_human` decisions.
   */
  gate?: GatePolicy;
  /**
   * Refuse to run if the model is offered a tool we did not define. On by default:
   * this is the guard that keeps a built-in from silently reappearing.
   */
  verifyToolSurface?: boolean;
  /** Receives schema-conversion diagnostics so the caller can surface them. */
  onDiagnostics?: (diagnostics: readonly string[]) => void;
}

/**
 * Build the session configuration.
 *
 * Exported so that tests verify the *production* configuration rather than a
 * hand-copied duplicate — the tool-surface guard is only worth anything if what it
 * checks is what actually runs.
 */
export function buildPiSessionOptions(options: PiDriverOptions): PiSessionPlan {
  const bridge = definePiTools(options.tools, options.toolPort);
  const systemPrompt =
    options.systemPrompt ?? buildSystemPrompt({ cwd: options.cwd, tools: options.tools });

  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  return {
    diagnostics: bridge.diagnostics,
    sessionOptions: {
      cwd: options.cwd,
      ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
      ...(options.modelRuntime === undefined ? {} : { modelRuntime: options.modelRuntime }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
      tools: options.tools.map((tool) => tool.name),
      customTools: bridge.tools,
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: options.maxRetries ?? 2 },
      }),
      resourceLoader,
    },
  };
}

/**
 * The tool port the session will actually use: our registry, wrapped in the
 * confirmation gate when a policy is configured.
 *
 * Exported so the wiring is testable without a live model. Left inline it could only be
 * trusted, not checked — and "the safety gate was actually installed" is precisely the
 * kind of claim that should not rest on trust.
 */
export function resolveToolPort(
  options: Pick<PiDriverOptions, "toolPort" | "gate" | "cwd">,
  humanInput: HumanInputChannel | undefined,
  report: { onRequested: (question: string) => void; onAnswered: (input: unknown) => void },
): ToolPort {
  if (options.gate === undefined) return options.toolPort;

  return createGatedToolPort(options.toolPort, {
    policy: options.gate,
    context: { cwd: options.cwd },
    humanInput,
    onRequested: report.onRequested,
    onAnswered: report.onAnswered,
  });
}

export function piDriver(options: PiDriverOptions): RunDriver {
  const expected = new Set(options.tools.map((tool) => tool.name));

  return async function* piDriver(state, ctx) {
    const startedAt = ctx.now();

    // --- callback → generator bridge -------------------------------------------
    // Built before the session, because the confirmation gate reports its round trip
    // through this queue and the gate is installed on the tool port.
    const queue: EventDraft[] = [];
    let wake: (() => void) | null = null;
    const signalWork = (): void => {
      const resume = wake;
      wake = null;
      resume?.();
    };
    const waitForWork = (): Promise<void> =>
      new Promise<void>((resolve) => {
        wake = resolve;
      });
    const enqueue = (draft: EventDraft): void => {
      queue.push(draft);
      signalWork();
    };

    const toolPort = resolveToolPort(options, ctx.humanInput, {
      // Surfaced as the same events the Core loop emits for a confirmation, so a
      // reader of the trace cannot tell which path asked.
      onRequested: (question) => enqueue({ type: "human_input_requested", question }),
      onAnswered: (input) => enqueue({ type: "human_input_received", input }),
    });

    const plan = buildPiSessionOptions({ ...options, toolPort });
    if (plan.diagnostics.length > 0) options.onDiagnostics?.(plan.diagnostics);
    const { session } = await createAgentSession(plan.sessionOptions);

    let promptSettled = false;
    let failure: unknown;
    const scratch = createNormalizationScratch();
    scratch.model = ctx.model;

    /**
     * Stop the run when a budget is spent.
     *
     * The Runtime enforces the time budget, but iteration and tool budgets are the
     * driver's to enforce because only the driver sees the SDK's internal turns. Without
     * this, `--max-iterations` and `--max-tool-calls` were silently inert on the real
     * path while working on the deterministic one.
     */
    const fail = (error: unknown): void => {
      failure ??= error;
      promptSettled = true;
      void session.abort();
      signalWork();
    };

    const enforceBudgets = (): void => {
      if (state.toolCalls > ctx.budget.maxToolCalls) {
        fail(
          new BudgetExceededError(
            "budget_tools",
            `tool budget exhausted (${ctx.budget.maxToolCalls})`,
          ),
        );
        return;
      }
      if (scratch.turns > ctx.budget.maxIterations) {
        fail(
          new BudgetExceededError(
            "budget_iterations",
            `iteration budget exhausted (${ctx.budget.maxIterations} model turns)`,
          ),
        );
      }
    };

    const unsubscribe = session.subscribe((event: SessionEvent) => {
      try {
        for (const draft of normalizeSessionEvent(event, state, scratch, ctx.now)) {
          enqueue(draft);
        }
        if (event.type === "tool_execution_start" || event.type === "agent_end") {
          enforceBudgets();
        }
      } catch (error) {
        failure ??= error;
        promptSettled = true;
        signalWork();
      }
    });

    const onAbort = (): void => {
      void session.abort();
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    try {
      if (options.verifyToolSurface !== false) {
        assertToolSurface(session.getActiveToolNames(), expected);
      }

      const promptPromise = session.prompt(state.task.input).then(
        () => {
          promptSettled = true;
          signalWork();
        },
        (error: unknown) => {
          // Never overwrite a budget failure: aborting the session to enforce a
          // budget makes the prompt reject with AbortError, which would otherwise
          // reclassify a deliberate stop as a user cancellation.
          failure ??= error;
          promptSettled = true;
          signalWork();
        },
      );

      for (;;) {
        const draft = queue.shift();
        if (draft !== undefined) {
          yield draft;
          continue;
        }
        if (promptSettled) break;
        await waitForWork();
      }

      await promptPromise;
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      unsubscribe();
      session.dispose();
    }

    if (failure !== undefined) throw failure;

    // Cancellation is a lifecycle state; let the Runtime classify it.
    if (ctx.signal.aborted) throw new DOMException("aborted", "AbortError");

    const content = finalAnswerText(scratch);
    state.transcript.push(assistantReplyEntry(content));
    yield { type: "decision_made", decision: { kind: "respond", content } };

    yield {
      type: "usage_reported",
      usage: toUsageReport(scratch.usage, state.toolCalls, ctx.now() - startedAt, ctx.model),
    };

    if (scratch.stopReason === "aborted") {
      yield { type: "run_cancelled" };
      return;
    }
    if (scratch.stopReason === "error") {
      // Classify from the provider's own message rather than assuming an outage: an
      // invalid key is `auth`, which is not retryable and tells the user what to fix.
      yield { type: "run_failed", error: classifyErrorStop(scratch) };
      return;
    }

    yield {
      type: "run_completed",
      status: scratch.missing.size > 0 ? "partial" : "complete",
      result: content,
      ...(scratch.missing.size > 0 ? { missingMaterial: [...scratch.missing].sort() } : {}),
    };
  };
}

/**
 * The guard that keeps a built-in tool from silently reappearing.
 *
 * Our tool names collide with pi's built-ins (`read`, `bash`, `edit`, `write`). If a
 * built-in were active, the model could call a `bash` that never passes through our
 * workspace boundary. Verified by probe (scripts/probe-session.mjs): the explicit
 * `tools` allowlist yields exactly our set, while `noTools: "builtin"` leaves the
 * built-in `find` in the registry and `noTools: "all"` disables our tools too.
 */
function assertToolSurface(active: readonly string[], expected: ReadonlySet<string>): void {
  const unexpected = active.filter((name) => !expected.has(name));
  if (unexpected.length > 0) {
    throw new AgentError(
      "runtime_error",
      `refusing to run: the model would be offered tools we did not define: ${unexpected.join(", ")}`,
    );
  }
}
