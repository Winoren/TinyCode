/**
 * Error normalization.
 *
 * Provider errors are the messiest surface an Agent Runtime touches: a 402 from a
 * billing API, an AbortError from a fired signal, and a TypeError from our own
 * code must not all arrive as `runtime_error`. Everything crosses this one
 * function so the failure taxonomy stays honest.
 *
 * The pattern table is a deliberate heuristic, not a spec. It is pinned by tests
 * (tests/errors.test.ts) so a change in behavior is visible.
 */

import { AgentError, type RunError, type RunErrorCode } from "./contracts.ts";

interface PatternRule {
  code: RunErrorCode;
  pattern: RegExp;
}

/**
 * Order matters: the first match wins, so the more specific provider signals must
 * precede the generic ones. The 402 case is recorded in the skill's verification
 * log as a real, expected failure that must map to `provider_unavailable`.
 */
const PATTERN_RULES: readonly PatternRule[] = [
  // --- auth (not retryable) ---
  { code: "auth", pattern: /\b401\b|unauthoriz|unauthenticated|invalid api key|invalid_api_key|authentication (failed|error)/i },
  { code: "auth", pattern: /\b403\b|forbidden|permission denied by provider/i },

  // --- billing / quota exhaustion (not retryable without human action) ---
  { code: "provider_unavailable", pattern: /\b402\b|insufficient (balance|funds|quota)|exceeded your current quota|billing|payment required/i },

  // --- rate limiting (retryable) ---
  { code: "rate_limited", pattern: /\b429\b|rate[ _-]?limit|too many requests|overloaded/i },

  // --- transport / availability (retryable) ---
  { code: "provider_unavailable", pattern: /\b50[0234]\b|service unavailable|bad gateway|internal server error/i },
  { code: "provider_unavailable", pattern: /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network error/i },

  // --- timeouts (retryable) ---
  { code: "timeout", pattern: /ETIMEDOUT|ESOCKETTIMEDOUT|timed? ?out|timeout/i },

  // --- tool-argument faults (not retryable) ---
  { code: "invalid_tool", pattern: /invalid (tool )?(arguments|parameters)|schema validation|zod/i },
];

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === "object" && "message" in error) {
    const value = (error as { message: unknown }).message;
    if (typeof value === "string") return value;
  }
  try {
    // `JSON.stringify` is typed as returning `string`, but returns `undefined` at
    // runtime for `undefined`, functions, and symbols. Relying on the declared type
    // here produced a real `undefined` message; the `??` is the actual guarantee.
    const encoded = JSON.stringify(error);
    return encoded ?? String(error);
  } catch {
    // Circular structures throw. A message is still required.
    return String(error);
  }
}

/**
 * Some SDKs attach the HTTP status to a field rather than the message. Reading it
 * explicitly keeps a bare `{ status: 402 }` from degrading to `runtime_error`.
 */
function statusOf(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  for (const value of [candidate.status, candidate.statusCode]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  if (typeof candidate.code === "number" && Number.isFinite(candidate.code)) return candidate.code;
  return undefined;
}

function codeForStatus(status: number): RunErrorCode | undefined {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "provider_unavailable";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 504) return "provider_unavailable";
  return undefined;
}

/**
 * Map anything thrown into the run error taxonomy.
 *
 * Cancellation is intentionally *not* classified here: a fired signal is a
 * lifecycle state (`run_cancelled`), and the Runtime handles it before this
 * function is consulted.
 */
export function normalizeUnknownError(error: unknown): RunError {
  if (error instanceof AgentError) return error.toRunError();

  const status = statusOf(error);
  if (status !== undefined) {
    const byStatus = codeForStatus(status);
    if (byStatus !== undefined) return { code: byStatus, message: messageOf(error) };
  }

  const message = messageOf(error);
  for (const rule of PATTERN_RULES) {
    if (rule.pattern.test(message)) return { code: rule.code, message };
  }

  return { code: "runtime_error", message };
}

/** True when the error was produced by an aborted signal rather than a real fault. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }
  return false;
}
