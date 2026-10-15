/**
 * Fold the raw event stream into timeline items.
 *
 * Pure and incremental: one event in, a new item list out. The same fold
 * renders the live stream and a historical replay — `foldAll(events)` is the
 * read-only path the history browser takes, so the two views cannot disagree.
 *
 * Grouping rules:
 * - text/thinking deltas accumulate into one assistant item;
 * - a `respond` decision overwrites the streamed text with the authoritative
 *   content, so a dropped delta can never produce a different final message;
 * - a tool card is created by `tool_started` and completed by `tool_completed`;
 *   observations that never had a tool call (refused, declined) create their
 *   own card so every outcome is visible;
 * - only the latest usage report is kept — the panel wants the final numbers.
 */

import type { AgentEvent, RunError, UsageReport } from "tinycode/dist/core/contracts.js";

export type ToolStatus = "running" | "success" | "error" | "declined";

export interface ToolItem {
  kind: "tool";
  key: string;
  toolCallId?: string;
  toolName: string;
  args?: unknown;
  status: ToolStatus;
  result?: unknown;
  error?: RunError;
  durationMs?: number;
  sequence: number;
}

export interface AssistantItem {
  kind: "assistant";
  key: string;
  text: string;
  thinking: string;
  sequence: number;
}

export interface NoteItem {
  kind: "note";
  key: string;
  text: string;
  tone: "system" | "retry";
  sequence: number;
}

export interface HumanItem {
  kind: "human";
  key: string;
  question: string;
  answer?: unknown;
  sequence: number;
}

export interface UsageItem {
  kind: "usage";
  key: string;
  usage: UsageReport;
  sequence: number;
}

export interface TerminalItem {
  kind: "terminal";
  key: string;
  event: AgentEvent;
  sequence: number;
}

export type TimelineItem =
  | ToolItem
  | AssistantItem
  | NoteItem
  | HumanItem
  | UsageItem
  | TerminalItem;

export function foldEvent(items: readonly TimelineItem[], event: AgentEvent): TimelineItem[] {
  switch (event.type) {
    case "run_started":
      return [...items, note(event, "Run started", "system")];

    case "run_resumed":
      return [...items, note(event, "Resumed", "system")];

    case "retry_scheduled":
      return [
        ...items,
        note(
          event,
          `Attempt ${event.attempt}/${event.maxAttempts} failed (${event.error.code}); ` +
            `retrying in ${formatDuration(event.delayMs)}`,
          "retry",
        ),
      ];

    case "text_delta":
      return appendToAssistant(items, event.sequence, event.delta, "");

    case "thinking_delta":
      return appendToAssistant(items, event.sequence, "", event.delta);

    case "decision_made": {
      const decision = event.decision;
      if (decision.kind !== "respond") return [...items];
      // Authoritative text replaces whatever streamed in.
      const tail = items[items.length - 1];
      if (tail !== undefined && tail.kind === "assistant") {
        return replaceTail(items, { ...tail, text: decision.content });
      }
      return [
        ...items,
        {
          kind: "assistant",
          key: `a-${event.sequence}`,
          text: decision.content,
          thinking: "",
          sequence: event.sequence,
        },
      ];
    }

    case "tool_started":
      return [
        ...items,
        {
          kind: "tool",
          key: `t-${event.sequence}`,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(event.args === undefined ? {} : { args: event.args }),
          status: "running",
          sequence: event.sequence,
        },
      ];

    case "tool_completed": {
      const index = findLastIndex(items, (item) => item.kind === "tool" && item.toolCallId === event.toolCallId);
      if (index === -1) {
        return [
          ...items,
          {
            kind: "tool",
            key: `t-${event.sequence}`,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: event.status,
            ...(event.result === undefined ? {} : { result: event.result }),
            ...(event.error === undefined ? {} : { error: event.error }),
            durationMs: event.durationMs,
            sequence: event.sequence,
          },
        ];
      }
      return items.map((item, i) => {
        if (i !== index || item.kind !== "tool") return item;
        return {
          ...item,
          status: event.status,
          ...(event.result === undefined ? {} : { result: event.result }),
          ...(event.error === undefined ? {} : { error: event.error }),
          durationMs: event.durationMs,
        };
      });
    }

    case "observation_added": {
      // A run tool call already has a card from tool_started/tool_completed. An
      // observation without one means the action never executed: refused by the
      // allowlist or declined by the operator.
      const hasCard = items.some(
        (item) => item.kind === "tool" && item.toolName === event.name && item.status !== "declined",
      );
      if (hasCard) return [...items];
      const declined = event.observation.error?.message.startsWith("declined by the operator") === true;
      return [
        ...items,
        {
          kind: "tool",
          key: `t-${event.sequence}`,
          toolName: event.name,
          status: declined ? "declined" : "error",
          ...(event.observation.error === undefined ? {} : { error: event.observation.error }),
          durationMs: event.observation.durationMs,
          sequence: event.sequence,
        },
      ];
    }

    case "human_input_requested":
      return [
        ...items,
        { kind: "human", key: `h-${event.sequence}`, question: event.question, sequence: event.sequence },
      ];

    case "human_input_received": {
      const index = findLastIndex(items, (item) => item.kind === "human");
      if (index === -1) return [...items];
      return items.map((item, i) =>
        i === index && item.kind === "human" ? { ...item, answer: event.input } : item,
      );
    }

    case "usage_reported":
      return [
        ...items.filter((item) => item.kind !== "usage"),
        { kind: "usage", key: `u-${event.sequence}`, usage: event.usage, sequence: event.sequence },
      ];

    case "run_completed":
    case "run_failed":
    case "run_cancelled":
      return [
        ...items,
        { kind: "terminal", key: `x-${event.sequence}`, event, sequence: event.sequence },
      ];

    default:
      // model_requested is transport noise for a reader; keep the timeline signal.
      return [...items];
  }
}

export function foldAll(events: readonly AgentEvent[]): TimelineItem[] {
  return events.reduce((items, event) => foldEvent(items, event), [] as TimelineItem[]);
}

function appendToAssistant(
  items: readonly TimelineItem[],
  sequence: number,
  text: string,
  thinking: string,
): TimelineItem[] {
  const tail = items[items.length - 1];
  if (tail !== undefined && tail.kind === "assistant") {
    return replaceTail(items, {
      ...tail,
      text: tail.text + text,
      thinking: tail.thinking + thinking,
    });
  }
  return [
    ...items,
    { kind: "assistant", key: `a-${sequence}`, text, thinking, sequence },
  ];
}

function replaceTail(items: readonly TimelineItem[], tail: TimelineItem): TimelineItem[] {
  const copy = [...items];
  copy[copy.length - 1] = tail;
  return copy;
}

function note(event: AgentEvent, text: string, tone: NoteItem["tone"]): NoteItem {
  return { kind: "note", key: `n-${event.sequence}`, text, tone, sequence: event.sequence };
}

function findLastIndex(
  items: readonly TimelineItem[],
  predicate: (item: TimelineItem) => boolean,
): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && predicate(item)) return i;
  }
  return -1;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Short excerpt of a tool result for the timeline card. */
export function excerpt(value: unknown, limit = 240): string {
  const text = typeof value === "string" ? value : safeJson(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
