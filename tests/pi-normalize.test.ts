/**
 * Pi event-normalization tests.
 *
 * The normalizer is the most SDK-coupled code in the project and the most likely to
 * break on an upgrade. Before it was extracted it could only be exercised by a live
 * provider turn, so it had no coverage at all. These tests drive it with synthetic SDK
 * events — no model, no network.
 *
 * The last suite is the important one: it asserts that the state the Pi path mutates
 * matches the state replay reconstructs from the emitted events. That is the
 * "fake and real paths mean the same thing" claim, made executable.
 */

import { describe, expect, it } from "vitest";

import { initialState, type AgentEvent, type AgentState, type EventDraft, type Task } from "../src/core/contracts.ts";
import { replayAgentState } from "../src/core/replay.ts";
import {
  classifyErrorStop,
  createNormalizationScratch,
  describeToolError,
  extractToolOutput,
  finalAnswerText,
  normalizeSessionEvent,
  toUsageReport,
  type NormalizationScratch,
  type SessionEvent,
} from "../src/adapters/pi/normalize.ts";

const TASK: Task = { id: "t", input: "fix it", cwd: "/ws" };

interface Harness {
  state: AgentState;
  scratch: NormalizationScratch;
  drafts: EventDraft[];
  now: () => number;
}

function makeHarness(): Harness {
  let tick = 0;
  const harness: Harness = {
    state: initialState(TASK),
    scratch: createNormalizationScratch(),
    drafts: [],
    now: () => (tick += 1),
  };
  return harness;
}

function feed(harness: Harness, event: unknown): void {
  harness.drafts.push(
    ...normalizeSessionEvent(event as SessionEvent, harness.state, harness.scratch, harness.now),
  );
}

const textDelta = (delta: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: {} },
});

const thinkingDelta = (delta: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial: {} },
});

const toolStart = (toolCallId: string, toolName: string, args: unknown = {}) => ({
  type: "tool_execution_start",
  toolCallId,
  toolName,
  args,
});

const toolEnd = (toolCallId: string, toolName: string, result: unknown, isError = false) => ({
  type: "tool_execution_end",
  toolCallId,
  toolName,
  result,
  isError,
});

const successEnvelope = (text: string, details: unknown = {}) => ({
  content: [{ type: "text", text }],
  details,
});

describe("message events", () => {
  it("maps text deltas and accumulates the answer", () => {
    const harness = makeHarness();
    feed(harness, textDelta("Hel"));
    feed(harness, textDelta("lo"));

    expect(harness.drafts).toEqual([
      { type: "text_delta", delta: "Hel" },
      { type: "text_delta", delta: "lo" },
    ]);
    expect(harness.scratch.fullText).toBe("Hello");
    expect(finalAnswerText(harness.scratch)).toBe("Hello");
  });

  it("maps thinking deltas without adding them to the answer", () => {
    const harness = makeHarness();
    feed(harness, thinkingDelta("hmm"));

    expect(harness.drafts).toEqual([{ type: "thinking_delta", delta: "hmm" }]);
    expect(harness.scratch.fullText).toBe("");
  });

  it("ignores event types that carry no product meaning", () => {
    const harness = makeHarness();
    for (const type of [
      "agent_start",
      "turn_start",
      "turn_end",
      "message_start",
      "message_end",
      "agent_settled",
      "queue_update",
      "entry_appended",
      "session_info_changed",
      "thinking_level_changed",
      "compaction_start",
      "compaction_end",
    ]) {
      feed(harness, { type });
    }

    expect(harness.drafts).toEqual([]);
    expect(harness.state).toEqual(initialState(TASK));
  });
});

describe("tool events", () => {
  it("emits an intent and a start, and counts the call", () => {
    const harness = makeHarness();
    feed(harness, toolStart("c1", "read", { path: "a.ts" }));

    expect(harness.drafts).toEqual([
      {
        type: "decision_made",
        decision: { kind: "call_tool", intent: { name: "read", arguments: { path: "a.ts" } } },
      },
      { type: "tool_started", toolCallId: "c1", toolName: "read", args: { path: "a.ts" } },
    ]);
    expect(harness.state.toolCalls).toBe(1);
    expect(harness.state.transcript).toHaveLength(2); // the user turn, then the intent
  });

  it("treats narration before an action as part of that action, not the answer", () => {
    const harness = makeHarness();
    feed(harness, textDelta("Let me look."));
    feed(harness, toolStart("c1", "read"));
    feed(harness, textDelta("Fixed."));

    expect(finalAnswerText(harness.scratch)).toBe("Fixed.");
    expect(harness.scratch.fullText).toBe("Let me look.Fixed.");
  });

  it("emits a completion and an observation for a successful tool", () => {
    const harness = makeHarness();
    feed(harness, toolStart("c1", "read", { path: "a.ts" }));
    harness.drafts.length = 0;
    feed(harness, toolEnd("c1", "read", successEnvelope("file body", { path: "a.ts" })));

    expect(harness.drafts.map((draft) => draft.type)).toEqual([
      "tool_completed",
      "observation_added",
    ]);
    const completion = harness.drafts[0];
    expect(completion).toMatchObject({ status: "success", toolName: "read" });

    expect(harness.state.observations).toHaveLength(1);
    expect(harness.state.observations[0]).toMatchObject({ name: "read", ok: true });
    expect(harness.state.iteration).toBe(1);
    expect(harness.scratch.missing.size).toBe(0);
  });

  it("normalizes a failed tool into the error taxonomy", () => {
    const harness = makeHarness();
    feed(harness, toolStart("c1", "bash"));
    harness.drafts.length = 0;
    feed(harness, toolEnd("c1", "bash", new Error("exit 3"), true));

    expect(harness.drafts[0]).toMatchObject({ type: "tool_completed", status: "error" });
    expect(harness.state.observations[0]).toMatchObject({ ok: false });
    // A plain failure is evidence, not an absent capability.
    expect(harness.scratch.missing.size).toBe(0);
  });

  it("marks a refused tool as missing material", () => {
    const harness = makeHarness();
    feed(harness, toolStart("c1", "deploy"));
    harness.drafts.length = 0;
    feed(harness, toolEnd("c1", "deploy", new Error("unknown tool: deploy"), true));

    expect(harness.state.observations[0]?.error?.code).toBe("invalid_tool");
    expect([...harness.scratch.missing]).toEqual(["deploy"]);
  });
});

describe("agent_end", () => {
  it("captures stop reason and usage, and counts a turn", () => {
    const harness = makeHarness();
    feed(harness, {
      type: "agent_end",
      willRetry: false,
      messages: [
        { role: "user" },
        { role: "assistant", stopReason: "stop", usage: { input: 12, output: 34 } },
      ],
    });

    expect(harness.scratch.stopReason).toBe("stop");
    expect(harness.scratch.usage).toEqual({ input: 12, output: 34 });
    expect(harness.scratch.turns).toBe(1);
    expect(harness.drafts).toEqual([]);
  });

  it("leaves usage undefined when the provider omits it", () => {
    const harness = makeHarness();
    feed(harness, {
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", stopReason: "stop" }],
    });

    expect(harness.scratch.usage).toBeUndefined();
    // Reporting zero here would be a fabrication, not a measurement.
    const report = toUsageReport(harness.scratch.usage, 0, 5, "deepseek/x");
    expect(report.inputTokens).toBeUndefined();
    expect(report.outputTokens).toBeUndefined();
  });
});

describe("classifying a turn that ended in error", () => {
  it("uses the provider's own message instead of assuming an outage", () => {
    // Found by driving the real path with an invalid key: it surfaced as
    // `provider_unavailable`, which is both misleading and retryable.
    const scratch = createNormalizationScratch();
    scratch.errorMessage = "401 Unauthorized: invalid api key";

    expect(classifyErrorStop(scratch).code).toBe("auth");
    expect(classifyErrorStop(scratch).message).toContain("invalid api key");
  });

  it("keeps a genuine balance failure as provider_unavailable", () => {
    const scratch = createNormalizationScratch();
    scratch.errorMessage = "402 Insufficient Balance";

    expect(classifyErrorStop(scratch).code).toBe("provider_unavailable");
  });

  it("falls back when the provider supplies no message", () => {
    const error = classifyErrorStop(createNormalizationScratch());
    expect(error.code).toBe("provider_unavailable");
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("captures errorMessage from the final assistant message", () => {
    const harness = makeHarness();
    feed(harness, {
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "401 Unauthorized" }],
    });

    expect(harness.scratch.errorMessage).toBe("401 Unauthorized");
    expect(classifyErrorStop(harness.scratch).code).toBe("auth");
  });
});

describe("payload extraction", () => {
  it("recovers our ToolOutput from the SDK's envelope", () => {
    const output = extractToolOutput(successEnvelope("hello", { path: "a.ts" }));
    expect(output.content).toBe("hello");
    expect(output.details).toEqual({ path: "a.ts" });
  });

  it("concatenates multiple text blocks and survives odd shapes", () => {
    expect(
      extractToolOutput({
        content: [{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }],
        details: null,
      }).content,
    ).toBe("ab");
    expect(extractToolOutput("bare string").content).toBe("bare string");
  });

  it("describes a tool error with a normalized code", () => {
    expect(describeToolError(new Error("401 Unauthorized")).code).toBe("auth");
    expect(describeToolError({ message: "429 Too Many Requests" }).code).toBe("rate_limited");
    expect(describeToolError(undefined).message.length).toBeGreaterThan(0);
  });

  it("maps the real SDK Usage field names, not the Skill's documented ones", () => {
    // The Skill's §2.4 lists inputTokens/cacheReadInputTokens, which is
    // agent-runner's normalized shape. Using those names would silently yield
    // undefined here, so this test pins the real mapping.
    const report = toUsageReport(
      { input: 100, output: 50, cost: { total: 0.0025 } },
      3,
      1234,
      "deepseek/deepseek-v4-flash",
    );

    expect(report).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      costUSD: 0.0025,
      toolCalls: 3,
      durationMs: 1234,
      model: "deepseek/deepseek-v4-flash",
    });
  });
});

describe("state mutation agrees with replay", () => {
  /**
   * The equivalence claim: whatever the Pi path mutates live must be exactly what the
   * event log reconstructs. If these diverge, a crash mid-run recovers to a different
   * state than the one the run actually held.
   */
  it("mutates AgentState identically to replaying its own events", () => {
    const harness = makeHarness();

    feed(harness, {
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", stopReason: "stop", usage: { input: 5, output: 7 } }],
    });
    feed(harness, textDelta("Let me read it."));
    feed(harness, toolStart("c1", "read", { path: "a.ts" }));
    feed(harness, toolEnd("c1", "read", successEnvelope("body", { path: "a.ts" })));
    feed(harness, toolStart("c2", "bash", { command: "node check.mjs" }));
    feed(harness, toolEnd("c2", "bash", new Error("exit 1"), true));
    feed(harness, toolStart("c3", "deploy"));
    feed(harness, toolEnd("c3", "deploy", new Error("unknown tool: deploy"), true));
    feed(harness, textDelta("Fixed and verified."));

    // The driver appends these itself after the turn settles.
    const content = finalAnswerText(harness.scratch);
    harness.state.transcript.push({ role: "assistant", text: content });
    harness.drafts.push({ type: "decision_made", decision: { kind: "respond", content } });
    harness.drafts.push({
      type: "run_completed",
      status: harness.scratch.missing.size > 0 ? "partial" : "complete",
      result: content,
      ...(harness.scratch.missing.size > 0
        ? { missingMaterial: [...harness.scratch.missing].sort() }
        : {}),
    });

    let sequence = 0;
    const events: AgentEvent[] = harness.drafts.map(
      (draft) => ({ ...draft, runId: "r1", sequence: sequence++, timestamp: 1 }) as AgentEvent,
    );

    const { state: replayed, terminal } = replayAgentState(events, TASK);

    expect(replayed.transcript).toEqual(harness.state.transcript);
    expect(replayed.observations).toEqual(harness.state.observations);
    expect(replayed.toolCalls).toBe(harness.state.toolCalls);
    expect(replayed.iteration).toBe(harness.state.iteration);

    expect(terminal).toMatchObject({
      type: "run_completed",
      status: "partial",
      missingMaterial: ["deploy"],
    });
  });
});
