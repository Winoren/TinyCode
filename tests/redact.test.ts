/**
 * Redaction unit tests.
 *
 * The security property lives in `tests/secrets.test.ts`; these cover the edge cases
 * that decide whether redaction is safe to apply to *everything* — because a redactor
 * that corrupts ordinary content would be its own kind of failure in a coding agent's
 * transcript.
 */

import { describe, expect, it } from "vitest";

import { createRedactor, identityRedactor, redactValue } from "../src/core/redact.ts";

const SECRET = "sk-abcdef1234567890";

describe("createRedactor", () => {
  it("replaces the secret everywhere it appears", () => {
    const redact = createRedactor([SECRET]);

    expect(redact(`key=${SECRET}`)).toBe("key=[redacted]");
    expect(redact(`${SECRET} and ${SECRET}`)).toBe("[redacted] and [redacted]");
    expect(redact("nothing to do here")).toBe("nothing to do here");
  });

  it("refuses to redact values short enough to be ordinary text", () => {
    // Blanking every occurrence of "abc" would mangle prose across the whole trace.
    const redact = createRedactor(["abc", "1234567", SECRET]);

    expect(redact.size).toBe(1);
    expect(redact.ignored).toEqual(["abc", "1234567"]);
    expect(redact("abc 1234567")).toBe("abc 1234567");
    expect(redact(SECRET)).toBe("[redacted]");
  });

  it("is a no-op when nothing qualifies", () => {
    const redact = createRedactor(["", "short"]);
    expect(redact.size).toBe(0);
    expect(redact("anything")).toBe("anything");
  });

  it("replaces a longer secret whole rather than leaving a fragment", () => {
    const shorter = "sk-abcdef";
    const longer = "sk-abcdef1234567890";
    const redact = createRedactor([shorter, longer]);

    expect(redact(`token ${longer}`)).toBe("token [redacted]");
  });

  it("treats regex metacharacters in a secret literally", () => {
    const awkward = "sk-a.b*c(d)[e]+f?g";
    const redact = createRedactor([awkward]);

    expect(redact(awkward)).toBe("[redacted]");
    // Must not behave as a pattern.
    expect(redact("sk-axbxcxdxexfxg")).toBe("sk-axbxcxdxexfxg");
  });

  it("identityRedactor changes nothing", () => {
    expect(identityRedactor(SECRET)).toBe(SECRET);
    expect(identityRedactor.size).toBe(0);
  });
});

describe("redactValue", () => {
  it("redacts nested strings in objects and arrays", () => {
    const redact = createRedactor([SECRET]);

    const input = {
      error: { message: `failed with ${SECRET}` },
      results: [`a ${SECRET} b`, "clean"],
      count: 3,
      flag: true,
      nothing: null,
    };

    expect(redactValue(input, redact)).toEqual({
      error: { message: "failed with [redacted]" },
      results: ["a [redacted] b", "clean"],
      count: 3,
      flag: true,
      nothing: null,
    });
  });

  it("returns the original reference when nothing needed redacting", () => {
    // Copy-on-write: tool results can be hundreds of kilobytes, and duplicating them
    // on every event would be a real cost.
    const redact = createRedactor([SECRET]);
    const input = { message: "clean", nested: { list: ["also clean"] } };

    expect(redactValue(input, redact)).toBe(input);
  });

  it("returns the original reference when there is nothing to redact at all", () => {
    const input = { message: `failed with ${SECRET}` };
    expect(redactValue(input, identityRedactor)).toBe(input);
  });

  it("does not silently mangle class instances it cannot copy safely", () => {
    const redact = createRedactor([SECRET]);
    class Holder {
      constructor(readonly value: string) {}
    }
    const holder = new Holder(`contains ${SECRET}`);

    expect(redactValue(holder, redact)).toBe(holder);
  });
});
