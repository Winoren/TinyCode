/**
 * Event rendering — the product surface.
 *
 * The CLI consumes the same product-level `AgentEvent` stream an SSE frontend would;
 * only the presentation differs. That is the point of normalizing SDK events at the
 * Runtime boundary: this file has no idea the Pi SDK exists.
 *
 * Sinks are injected so the renderer can be asserted on without capturing stdout.
 */

import type { AgentEvent } from "../core/contracts.ts";

export interface RenderSinks {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface RenderOptions {
  /** Print each event as a JSON line instead of prose. */
  json?: boolean;
  showThinking?: boolean;
}

export interface EventRenderer {
  handle(event: AgentEvent): void;
  /** Called once after the stream ends. */
  finish(): void;
}

const MAX_ARG_SUMMARY = 100;

export function createEventRenderer(
  sinks: RenderSinks,
  options: RenderOptions = {},
): EventRenderer {
  let wroteText = false;
  let wroteAnything = false;

  const line = (text: string): void => {
    sinks.out(`${text}\n`);
  };

  return {
    handle(event: AgentEvent): void {
      if (options.json === true) {
        sinks.out(`${JSON.stringify(event)}\n`);
        return;
      }

      switch (event.type) {
        case "run_started":
          return;

        case "text_delta":
          wroteText = true;
          wroteAnything = true;
          sinks.out(event.delta);
          return;

        case "thinking_delta":
          if (options.showThinking === true) sinks.err(event.delta);
          return;

        case "tool_started": {
          if (wroteText) {
            sinks.out("\n");
            wroteText = false;
          }
          wroteAnything = true;
          line(`● ${event.toolName} ${summarizeArgs(event.args)}`.trimEnd());
          return;
        }

        case "tool_completed": {
          const mark = event.status === "success" ? "✓" : "✗";
          line(`  ${mark} ${event.durationMs}ms`);
          return;
        }

        case "human_input_requested":
          line(`? ${event.question}`);
          return;

        case "retry_scheduled":
          // Visible on purpose: without this line a transient provider failure and a
          // real failure look identical to the person watching.
          sinks.err(
            `  ↻ retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms ` +
              `after ${event.error.code}\n`,
          );
          return;

        case "run_resumed":
          // The question and answer are already on screen; nothing to add.
          return;

        case "run_completed": {
          if (wroteText) sinks.out("\n");
          if (event.result.trim() !== "") {
            line("");
            line(event.result.trim());
          }
          line("");
          const status =
            event.status === "partial"
              ? `partial — missing: ${(event.missingMaterial ?? []).join(", ")}`
              : "complete";
          line(`— ${status}`);
          return;
        }

        case "run_failed":
          sinks.err(`\n✗ run failed [${event.error.code}]: ${event.error.message}\n`);
          return;

        case "run_cancelled":
          sinks.err("\n⏹ cancelled\n");
          return;

        case "usage_reported": {
          const parts: string[] = [`tools ${event.usage.toolCalls}`, `${event.usage.durationMs}ms`];
          if (event.usage.inputTokens !== undefined) parts.push(`in ${event.usage.inputTokens}`);
          if (event.usage.outputTokens !== undefined) parts.push(`out ${event.usage.outputTokens}`);
          // Absent token counts are reported as unknown, never as zero: the deepseek
          // path genuinely omits usage, and inventing a number would be a lie.
          if (event.usage.inputTokens === undefined && event.usage.outputTokens === undefined) {
            parts.push("tokens unknown");
          }
          sinks.err(`[${parts.join(" · ")}]\n`);
          return;
        }

        default:
          return;
      }
    },

    finish(): void {
      if (wroteAnything && !options.json) sinks.out("\n");
    },
  };
}

/** Render tool arguments compactly; the full object would swamp the transcript. */
function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args !== "object") return truncate(String(args));

  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return "";

  return truncate(
    entries
      .map(([key, value]) => `${key}=${renderValue(value)}`)
      .join(" "),
  );
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return Array.isArray(value) ? `[${value.length}]` : "{…}";
  return String(value);
}

function truncate(text: string): string {
  return text.length > MAX_ARG_SUMMARY ? `${text.slice(0, MAX_ARG_SUMMARY)}…` : text;
}
