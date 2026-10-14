/**
 * The Pi Agent SDK driver.
 *
 * The SDK runs its *own* agent loop: `session.prompt()` drives model turns and
 * reports a stream of events. We do not fight that; we normalize it. Every SDK event
 * is translated into the same `EventDraft` vocabulary the deterministic Core loop
 * emits, and the AgentState is mutated through the same shared helpers
 * (`transcript.ts`), so the fake path and the real path mean the same thing.
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
  toolOutput,
  type EventDraft,
  type Observation,
  type RunError,
  type ToolOutput,
  type ToolPort,
  type UsageReport,
} from "../../core/contracts.ts";
import { normalizeUnknownError } from "../../core/errors.ts";
import type { RunDriver } from "../../core/loop.ts";
import { assistantIntentEntry, assistantReplyEntry, toolResultEntry } from "../../core/transcript.ts";
import type { AnyToolDefinition } from "../../tools/types.ts";
import { definePiTools } from "./tools.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

type SessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
type SessionInstance = Awaited<ReturnType<typeof createAgentSession>>["session"];
type SessionEvent = Parameters<Parameters<SessionInstance["subscribe"]>[0]>[0];

/** The subset of the SDK's `Usage` we map. Field names verified against pi-ai. */
interface SdkUsage {
  input?: number;
  output?: number;
  cost?: { total?: number };
}

export interface PiDriverOptions {
  cwd: string;
  /** Omitted means the SDK resolves a model from settings/first available. */
  model?: NonNullable<SessionOptions["model"]>;
  modelRuntime?: SessionOptions["modelRuntime"];
  agentDir?: string;
  thinkingLevel?: NonNullable<SessionOptions["thinkingLevel"]>;
  /** Our tool implementations. */
  toolPort: ToolPort;
  /** The tools we intend to expose; also becomes the SDK allowlist. */
  tools: readonly AnyToolDefinition[];
  systemPrompt?: string;
  /**
   * Refuse to run if the model is offered a tool we did not define. On by default:
   * this is the guard that keeps a built-in from silently reappearing.
   */
  verifyToolSurface?: boolean;
  /** Receives schema-conversion diagnostics so the caller can surface them. */
  onDiagnostics?: (diagnostics: readonly string[]) => void;
}

export interface PiSessionPlan {
  sessionOptions: SessionOptions;
  /** Non-empty when a tool schema could not be converted to a model-facing schema. */
  diagnostics: string[];
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
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      resourceLoader,
    },
  };
}

export function piDriver(options: PiDriverOptions): RunDriver {
  const expected = new Set(options.tools.map((tool) => tool.name));

  return async function* piDriver(state, ctx) {
    const startedAt = ctx.now();
    const plan = buildPiSessionOptions(options);
    if (plan.diagnostics.length > 0) options.onDiagnostics?.(plan.diagnostics);
    const { session } = await createAgentSession(plan.sessionOptions);

    // --- callback → generator bridge -------------------------------------------
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

    let promptSettled = false;
    let failure: unknown;
    let stopReason: string | undefined;
    let sdkUsage: SdkUsage | undefined;
    let fullText = "";
    let lastSegmentText = "";
    const missing = new Set<string>();
    const startedTools = new Map<string, { readonly startedAt: number }>();

    const enqueue = (draft: EventDraft): void => {
      queue.push(draft);
      signalWork();
    };

    function handle(event: SessionEvent): void {
      switch (event.type) {
        case "message_update": {
          const inner = event.assistantMessageEvent;
          if (inner.type === "text_delta") {
            fullText += inner.delta;
            lastSegmentText += inner.delta;
            enqueue({ type: "text_delta", delta: inner.delta });
          } else if (inner.type === "thinking_delta") {
            enqueue({ type: "thinking_delta", delta: inner.delta });
          }
          return;
        }

        case "tool_execution_start": {
          const args = (event.args ?? {}) as Record<string, unknown>;
          const intent = { name: event.toolName, arguments: args };
          startedTools.set(event.toolCallId, { startedAt: ctx.now() });
          state.toolCalls += 1;
          state.transcript.push(assistantIntentEntry(intent));
          // Text emitted before an action belongs to that action, not to the answer.
          lastSegmentText = "";
          enqueue({ type: "decision_made", decision: { kind: "call_tool", intent } });
          enqueue({
            type: "tool_started",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args,
          });
          return;
        }

        case "tool_execution_end": {
          const started = startedTools.get(event.toolCallId);
          const durationMs = started === undefined ? 0 : ctx.now() - started.startedAt;
          const isError = event.isError === true;

          const observation: Observation = isError
            ? {
                name: event.toolName,
                ok: false,
                error: describeToolError(event.result),
                durationMs,
                observedAt: ctx.now(),
              }
            : {
                name: event.toolName,
                ok: true,
                result: extractToolOutput(event.result),
                durationMs,
                observedAt: ctx.now(),
              };

          if (isError && observation.error?.code === "invalid_tool") {
            // A refused tool is an absent capability, not a transient failure.
            missing.add(event.toolName);
          }

          state.observations.push(observation);
          state.transcript.push(toolResultEntry(event.toolName, observation));
          state.iteration += 1;

          enqueue({
            type: "tool_completed",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: isError ? "error" : "success",
            ...(observation.result === undefined ? {} : { result: observation.result }),
            ...(observation.error === undefined ? {} : { error: observation.error }),
            durationMs,
          });
          enqueue({ type: "observation_added", name: event.toolName, observation });
          return;
        }

        case "agent_end": {
          const messages = event.messages as readonly {
            role?: string;
            stopReason?: string;
            usage?: SdkUsage;
          }[];
          const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
          stopReason = lastAssistant?.stopReason ?? stopReason;
          // The deepseek path is known to omit `usage` here; leave it undefined
          // rather than reporting fabricated zeros.
          sdkUsage = lastAssistant?.usage ?? sdkUsage;
          return;
        }

        default:
          // turn_start/end, message_start/end, queue_update, compaction_*,
          // entry_appended, session_info_changed, thinking_level_changed, agent_settled:
          // no product-level meaning that the events above do not already carry.
          return;
      }
    }

    const unsubscribe = session.subscribe((event) => {
      try {
        handle(event);
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
          failure = error;
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

    const content = (lastSegmentText.trim() !== "" ? lastSegmentText : fullText).trim();
    state.transcript.push(assistantReplyEntry(content));
    yield { type: "decision_made", decision: { kind: "respond", content } };

    yield {
      type: "usage_reported",
      usage: toUsageReport(sdkUsage, state.toolCalls, ctx.now() - startedAt, ctx.model),
    };

    if (stopReason === "aborted") {
      yield { type: "run_cancelled" };
      return;
    }
    if (stopReason === "error") {
      yield {
        type: "run_failed",
        error: { code: "provider_unavailable", message: "the model turn reported an error" },
      };
      return;
    }

    yield {
      type: "run_completed",
      status: missing.size > 0 ? "partial" : "complete",
      result: content,
      ...(missing.size > 0 ? { missingMaterial: [...missing].sort() } : {}),
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

/** Recover our `ToolOutput` from the SDK's `AgentToolResult` envelope. */
function extractToolOutput(result: unknown): ToolOutput {
  if (result !== null && typeof result === "object" && "content" in result) {
    const envelope = result as { content?: unknown; details?: unknown };
    let text = "";
    if (Array.isArray(envelope.content)) {
      text = envelope.content
        .map((part) =>
          part !== null && typeof part === "object" && (part as { type?: string }).type === "text"
            ? String((part as { text?: unknown }).text ?? "")
            : "",
        )
        .join("");
    }
    return toolOutput(text, envelope.details);
  }
  return toolOutput(String(result));
}

function describeToolError(result: unknown): RunError {
  const message =
    typeof result === "string"
      ? result
      : result !== null && typeof result === "object" && "message" in result
        ? String((result as { message: unknown }).message)
        : JSON.stringify(result ?? "tool failed");
  return { code: normalizeUnknownError(new Error(message)).code, message };
}

function toUsageReport(
  usage: SdkUsage | undefined,
  toolCalls: number,
  durationMs: number,
  model: string | undefined,
): UsageReport {
  // Field names come from pi-ai's `Usage` (input/output/cost.total), NOT from the
  // Skill's §2.4 list (inputTokens/cacheReadInputTokens), which describes
  // agent-runner's normalized shape. See docs/adapter-mapping.md §2.4.
  const report: UsageReport = { toolCalls, durationMs };
  if (model !== undefined) report.model = model;
  if (usage?.input !== undefined) report.inputTokens = usage.input;
  if (usage?.output !== undefined) report.outputTokens = usage.output;
  if (usage?.cost?.total !== undefined) report.costUSD = usage.cost.total;
  return report;
}
