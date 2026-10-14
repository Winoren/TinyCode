/**
 * SDK event normalization — extracted as a pure function so it can be tested.
 *
 * This is the most SDK-coupled code in the project and therefore the most likely to
 * break on an upgrade. While it lived inside the driver's subscription callback the
 * only way to exercise it was a live provider turn, which left it with zero coverage.
 * As a pure function over `(event, state, scratch, now)` it is fully testable with
 * synthetic events, no model required.
 *
 * The contract it protects: raw SDK events never leave the Runtime. Everything here
 * returns the same `EventDraft` vocabulary the deterministic Core loop emits.
 */

import { createAgentSession } from "@earendil-works/pi-coding-agent";

import {
  toolOutput,
  type AgentState,
  type EventDraft,
  type Observation,
  type RunError,
  type ToolOutput,
  type UsageReport,
} from "../../core/contracts.ts";
import { normalizeUnknownError } from "../../core/errors.ts";
import { assistantIntentEntry, toolResultEntry } from "../../core/transcript.ts";

type SessionInstance = Awaited<ReturnType<typeof createAgentSession>>["session"];
export type SessionEvent = Parameters<Parameters<SessionInstance["subscribe"]>[0]>[0];

/** The subset of the SDK's `Usage` we map. Field names verified against pi-ai. */
export interface SdkUsage {
  input?: number;
  output?: number;
  cost?: { total?: number };
}

/**
 * Everything the normalizer needs that is not part of `AgentState`, kept separate so
 * the state stays a Core concept rather than accumulating SDK bookkeeping.
 */
export interface NormalizationScratch {
  startedTools: Map<string, { readonly startedAt: number }>;
  fullText: string;
  lastSegmentText: string;
  stopReason: string | undefined;
  /**
   * The provider's own error text from the final assistant message.
   *
   * Discarding this was a real defect: an invalid API key surfaced as a synthesised
   * "the model turn reported an error" classified `provider_unavailable`, which is both
   * misleading (it is an auth problem the user can fix) and retryable (so it burned
   * three attempts before failing).
   */
  errorMessage: string | undefined;
  usage: SdkUsage | undefined;
  /** Tool names the run could not use; drives complete-vs-partial. */
  missing: Set<string>;
  /** SDK-level model turns, which is what `maxIterations` bounds. */
  turns: number;
  /** Model label for the trace, supplied by the driver. */
  model: string | undefined;
}

export function createNormalizationScratch(): NormalizationScratch {
  return {
    startedTools: new Map(),
    fullText: "",
    lastSegmentText: "",
    stopReason: undefined,
    errorMessage: undefined,
    usage: undefined,
    missing: new Set(),
    turns: 0,
    model: undefined,
  };
}

/**
 * Translate one SDK event, mutating `state` and `scratch` exactly as replay will
 * reconstruct them. Returns the drafts to emit, in order.
 */
export function normalizeSessionEvent(
  event: SessionEvent,
  state: AgentState,
  scratch: NormalizationScratch,
  now: () => number,
): EventDraft[] {
  switch (event.type) {
    case "turn_start": {
      // An SDK "turn" is one model call plus its tool executions, so this is the SDK's
      // equivalent of the Core loop asking the model. Without it the Pi path never
      // emitted `model_requested`, and the two paths' traces were not comparable —
      // which is exactly what the golden-transcript equivalence check needs them to be.
      //
      // It is also what `maxIterations` counts. Counting `agent_end` instead was a real
      // defect: that event fires **once per prompt**, not once per model call, so the
      // iteration budget was measuring the wrong thing and could barely ever trip.
      scratch.turns += 1;
      return [
        { type: "model_requested", ...(scratch.model === undefined ? {} : { model: scratch.model }) },
      ];
    }

    case "message_update": {
      const inner = event.assistantMessageEvent;
      if (inner.type === "text_delta") {
        scratch.fullText += inner.delta;
        scratch.lastSegmentText += inner.delta;
        return [{ type: "text_delta", delta: inner.delta }];
      }
      if (inner.type === "thinking_delta") {
        return [{ type: "thinking_delta", delta: inner.delta }];
      }
      return [];
    }

    case "tool_execution_start": {
      const args = (event.args ?? {}) as Record<string, unknown>;
      const intent = { name: event.toolName, arguments: args };
      scratch.startedTools.set(event.toolCallId, { startedAt: now() });
      state.toolCalls += 1;
      state.transcript.push(assistantIntentEntry(intent));
      // Text emitted before an action belongs to that action, not to the answer.
      scratch.lastSegmentText = "";
      return [
        { type: "decision_made", decision: { kind: "call_tool", intent } },
        { type: "tool_started", toolCallId: event.toolCallId, toolName: event.toolName, args },
      ];
    }

    case "tool_execution_end": {
      const started = scratch.startedTools.get(event.toolCallId);
      const durationMs = started === undefined ? 0 : now() - started.startedAt;
      const isError = event.isError === true;

      const observation: Observation = isError
        ? {
            name: event.toolName,
            ok: false,
            error: describeToolError(event.result),
            durationMs,
            observedAt: now(),
          }
        : {
            name: event.toolName,
            ok: true,
            result: extractToolOutput(event.result),
            durationMs,
            observedAt: now(),
          };

      if (isError && observation.error !== undefined && isRefusal(observation.error.message)) {
        scratch.missing.add(event.toolName);
      }

      state.observations.push(observation);
      state.transcript.push(toolResultEntry(event.toolName, observation));
      state.iteration += 1;

      return [
        {
          type: "tool_completed",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: isError ? "error" : "success",
          ...(observation.result === undefined ? {} : { result: observation.result }),
          ...(observation.error === undefined ? {} : { error: observation.error }),
          durationMs,
        },
        { type: "observation_added", name: event.toolName, observation },
      ];
    }

    case "agent_end": {
      const messages = event.messages as readonly {
        role?: string;
        stopReason?: string;
        errorMessage?: string;
        usage?: SdkUsage;
      }[];
      const lastAssistant = [...messages]
        .reverse()
        .find((message) => message.role === "assistant");
      scratch.stopReason = lastAssistant?.stopReason ?? scratch.stopReason;
      scratch.errorMessage = lastAssistant?.errorMessage ?? scratch.errorMessage;
      // The deepseek path is known to omit `usage` here; leave it undefined rather
      // than reporting fabricated zeros.
      scratch.usage = lastAssistant?.usage ?? scratch.usage;
      return [];
    }

    default:
      // turn_end, message_start/end, queue_update, compaction_*,
      // entry_appended, session_info_changed, thinking_level_changed, agent_settled:
      // no product-level meaning that the events above do not already carry.
      return [];
  }
}

/**
 * Whether an error means the capability itself was unavailable.
 *
 * A missing file is evidence the model can act on; a tool that does not exist is an absent
 * capability. Only the latter belongs in `missingMaterial` — treating every tool error as
 * missing material made an ordinary "read a path that is not there" report the run as
 * partial. This mirrors the Core loop, which records missing material only for a refusal.
 */
function isRefusal(message: string): boolean {
  return /unknown tool|not in allowlist|tool .* not found/i.test(message);
}

/** The answer text: the last segment if the model spoke after its final action. */
export function finalAnswerText(scratch: NormalizationScratch): string {
  const last = scratch.lastSegmentText.trim();
  return last !== "" ? last : scratch.fullText.trim();
}

/** Recover our `ToolOutput` from the SDK's `AgentToolResult` envelope. */
export function extractToolOutput(result: unknown): ToolOutput {
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

export function describeToolError(result: unknown): RunError {
  const message = errorTextOf(result);
  return { code: normalizeUnknownError(new Error(message)).code, message };
}

/**
 * Pull the message out of whatever the SDK handed back for a failed tool.
 *
 * The SDK wraps a thrown error with the *same* `AgentToolResult` envelope it uses for
 * success — `{ content: [{ type: "text", text: message }], details: {} }` — and drops
 * our error code. Looking for a `message` field (which this shape never has) meant every
 * tool error on the SDK path was reported as a JSON blob classified `runtime_error`,
 * losing both the message and the taxonomy. Found by the live test, which is the only
 * place a real envelope ever appeared.
 */
function errorTextOf(result: unknown): string {
  if (typeof result === "string") return result;

  if (result !== null && typeof result === "object") {
    const candidate = result as { message?: unknown; content?: unknown };

    if (typeof candidate.message === "string" && candidate.message !== "") {
      return candidate.message;
    }

    if (Array.isArray(candidate.content)) {
      const text = candidate.content
        .map((part) =>
          part !== null && typeof part === "object" && (part as { type?: string }).type === "text"
            ? String((part as { text?: unknown }).text ?? "")
            : "",
        )
        .join("");
      if (text !== "") return text;
    }
  }

  return JSON.stringify(result ?? "tool failed");
}

export function toUsageReport(
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

  // The SDK fills `usage` with **zeros** when the provider does not report it — verified
  // by probe, not assumed. Passing those through made the trace claim a real model call
  // consumed no tokens, which is impossible for any actual request. A zero input count is
  // the signal for "not reported", so the fields are omitted and the runtime reports the
  // cost as unknown rather than inventing a number.
  const tokensReported = usage !== undefined && ((usage.input ?? 0) > 0 || (usage.output ?? 0) > 0);
  if (tokensReported) {
    if (usage.input !== undefined) report.inputTokens = usage.input;
    if (usage.output !== undefined) report.outputTokens = usage.output;
    if (usage.cost?.total !== undefined) report.costUSD = usage.cost.total;
  }

  return report;
}

/**
 * Classify a turn that ended in error, using the provider's own message.
 *
 * Exported so the mapping is testable: an invalid key must come back as `auth` — not
 * retryable and not vague — while a genuine outage stays `provider_unavailable`.
 */
export function classifyErrorStop(scratch: NormalizationScratch): RunError {
  if (scratch.errorMessage === undefined || scratch.errorMessage.trim() === "") {
    return {
      code: "provider_unavailable",
      message: "the model turn reported an error without a message",
    };
  }
  return normalizeUnknownError(new Error(scratch.errorMessage));
}
