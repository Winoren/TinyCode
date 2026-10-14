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
  usage: SdkUsage | undefined;
  /** Tool names the run could not use; drives complete-vs-partial. */
  missing: Set<string>;
  /** SDK-level model turns, which is what `maxIterations` bounds. */
  turns: number;
}

export function createNormalizationScratch(): NormalizationScratch {
  return {
    startedTools: new Map(),
    fullText: "",
    lastSegmentText: "",
    stopReason: undefined,
    usage: undefined,
    missing: new Set(),
    turns: 0,
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

      if (isError && observation.error?.code === "invalid_tool") {
        // A refused tool is an absent capability, not a transient failure.
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
        usage?: SdkUsage;
      }[];
      const lastAssistant = [...messages]
        .reverse()
        .find((message) => message.role === "assistant");
      scratch.stopReason = lastAssistant?.stopReason ?? scratch.stopReason;
      // The deepseek path is known to omit `usage` here; leave it undefined rather
      // than reporting fabricated zeros.
      scratch.usage = lastAssistant?.usage ?? scratch.usage;
      scratch.turns += 1;
      return [];
    }

    default:
      // turn_start/end, message_start/end, queue_update, compaction_*,
      // entry_appended, session_info_changed, thinking_level_changed, agent_settled:
      // no product-level meaning that the events above do not already carry.
      return [];
  }
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
  const message =
    typeof result === "string"
      ? result
      : result !== null && typeof result === "object" && "message" in result
        ? String((result as { message: unknown }).message)
        : JSON.stringify(result ?? "tool failed");
  return { code: normalizeUnknownError(new Error(message)).code, message };
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
  if (usage?.input !== undefined) report.inputTokens = usage.input;
  if (usage?.output !== undefined) report.outputTokens = usage.output;
  if (usage?.cost?.total !== undefined) report.costUSD = usage.cost.total;
  return report;
}
