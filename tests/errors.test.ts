/**
 * Error-normalization tests.
 *
 * These pin the failure taxonomy. The 402 case is not hypothetical: the Skill's
 * verification log records deepseek returning `402 Insufficient Balance` as a real,
 * expected failure that must surface as `provider_unavailable` — a typed, honest
 * run failure — rather than escaping as an untyped crash.
 */

import { describe, expect, it } from "vitest";

import { AgentError } from "../src/core/contracts.ts";
import { isAbortError, normalizeUnknownError } from "../src/core/errors.ts";

describe("normalizeUnknownError", () => {
  it("preserves the code of an AgentError", () => {
    expect(normalizeUnknownError(new AgentError("no_progress", "spun"))).toEqual({
      code: "no_progress",
      message: "spun",
    });
  });

  it("maps a bare 402 balance failure to provider_unavailable", () => {
    expect(normalizeUnknownError(new Error("402 Insufficient Balance")).code).toBe(
      "provider_unavailable",
    );
  });

  it("reads an HTTP status carried as a field, not just in the message", () => {
    expect(normalizeUnknownError({ status: 402, message: "Payment Required" }).code).toBe(
      "provider_unavailable",
    );
    expect(normalizeUnknownError({ statusCode: 429 }).code).toBe("rate_limited");
  });

  it.each([
    [new Error("401 Unauthorized"), "auth"],
    [new Error("invalid api key"), "auth"],
    [new Error("403 Forbidden"), "auth"],
    [new Error("429 Too Many Requests"), "rate_limited"],
    [new Error("rate limit exceeded"), "rate_limited"],
    [new Error("503 Service Unavailable"), "provider_unavailable"],
    [new Error("fetch failed"), "provider_unavailable"],
    [new Error("connect ECONNREFUSED 127.0.0.1:443"), "provider_unavailable"],
    [new Error("request ETIMEDOUT"), "timeout"],
    [new Error("socket timeout"), "timeout"],
    [new Error("invalid tool arguments"), "invalid_tool"],
    [new Error("something entirely unexpected"), "runtime_error"],
    ["a bare string failure", "runtime_error"],
  ])("classifies %s as %s", (error, expected) => {
    expect(normalizeUnknownError(error).code).toBe(expected);
  });

  it("always returns a message, even for values that do not stringify", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(normalizeUnknownError(circular).message.length).toBeGreaterThan(0);
    expect(normalizeUnknownError(undefined).message.length).toBeGreaterThan(0);
    expect(normalizeUnknownError(null).message.length).toBeGreaterThan(0);
  });

  it("identifies abort-shaped errors as cancellation, not faults", () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    expect(isAbortError(abortError)).toBe(true);
    expect(isAbortError(new Error("real failure"))).toBe(false);
  });
});
