/**
 * Deterministic Core loop tests.
 *
 * These prove the loop semantics with fake adapters only — no process, network,
 * database, or SDK. Development-sequence step 2 in the Skill.
 */

import { describe, expect, it } from "vitest";

import { fakeTools, functionalModel, scriptedModel } from "../src/adapters/fake/index.ts";
import { BudgetExceededError } from "../src/core/contracts.ts";
import {
  DEFAULT_BUDGET,
  initialState,
  type AgentEvent,
  type AgentState,
  type Decision,
  type Task,
} from "../src/core/contracts.ts";
import { coreLoopDriver, type DriverContext, type RunDriver } from "../src/core/loop.ts";
import { replayAgentState } from "../src/core/replay.ts";

const TASK: Task = { id: "task-1", input: "fix the failing test", cwd: "/tmp/repo" };

function makeContext(overrides: Partial<DriverContext> = {}): DriverContext {
  let tick = 0;
  const next = (): number => {
    tick += 1;
    return 1_000 + tick;
  };
  return {
    budget: { ...DEFAULT_BUDGET },
    signal: new AbortController().signal,
    now: next,
    newToolCallId: () => `call-${next()}`,
    humanInput: undefined,
    model: "fake-model",
    ...overrides,
  };
}

/** Wrap a driver in a minimal envelope. The real Runtime replaces this. */
async function drive(
  driver: RunDriver,
  state: AgentState,
  ctx: DriverContext,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  let sequence = 0;
  for await (const draft of driver(state, ctx)) {
    events.push({ ...draft, runId: "run-1", sequence: sequence++, timestamp: ctx.now() } as AgentEvent);
  }
  return events;
}

function typesOf(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

function terminalEvents(events: readonly AgentEvent[]): AgentEvent[] {
  return events.filter(
    (event) =>
      event.type === "run_completed" ||
      event.type === "run_failed" ||
      event.type === "run_cancelled",
  );
}

describe("core loop — happy path", () => {
  it("completes a respond-only run with an ordered, single-terminal event stream", async () => {
    const model = scriptedModel([{ kind: "respond", content: "Nothing to do." }]);
    const driver = coreLoopDriver({ model, tools: fakeTools({}) });
    const state = initialState(TASK);

    const events = await drive(driver, state, makeContext());

    expect(typesOf(events)).toEqual([
      "model_requested",
      "decision_made",
      "usage_reported",
      "run_completed",
    ]);
    const terminal = terminalEvents(events);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: "run_completed", status: "complete" });
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
  });

  it("runs a full read → edit → verify loop and records both observations", async () => {
    const model = scriptedModel([
      { kind: "call_tool", intent: { name: "read", arguments: { path: "src/math.ts" } } },
      { kind: "call_tool", intent: { name: "edit", arguments: { path: "src/math.ts" } } },
      { kind: "respond", content: "Fixed the operator." },
    ]);
    const tools = fakeTools({
      read: (intent) => `contents of ${String(intent.arguments.path)}`,
      edit: () => ({ changed: 1 }),
    });
    const state = initialState(TASK);

    const events = await drive(coreLoopDriver({ model, tools }), state, makeContext());

    expect(typesOf(events)).toEqual([
      "model_requested",
      "decision_made",
      "tool_started",
      "tool_completed",
      "observation_added",
      "model_requested",
      "decision_made",
      "tool_started",
      "tool_completed",
      "observation_added",
      "model_requested",
      "decision_made",
      "usage_reported",
      "run_completed",
    ]);

    expect(state.observations).toHaveLength(2);
    expect(state.observations.every((observation) => observation.ok)).toBe(true);
    expect(state.toolCalls).toBe(2);
    expect(state.iteration).toBe(2);
    expect(tools.seen.map((intent) => intent.name)).toEqual(["read", "edit"]);

    const terminal = terminalEvents(events);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: "run_completed", status: "complete" });
  });
});

describe("core loop — refusal and isolation", () => {
  it("refuses an unknown tool, keeps it visible, and reports partial with missing material", async () => {
    const model = scriptedModel([
      { kind: "call_tool", intent: { name: "delete_everything", arguments: {} } },
      { kind: "respond", content: "I could not complete that." },
    ]);
    const tools = fakeTools({ read: () => "ok" });
    const state = initialState(TASK);

    const events = await drive(coreLoopDriver({ model, tools }), state, makeContext());

    // The refusal never reaches execution: no tool_started, no tool_completed.
    expect(typesOf(events)).not.toContain("tool_started");
    expect(typesOf(events)).not.toContain("tool_completed");

    const refusal = state.observations[0];
    expect(refusal).toMatchObject({
      name: "delete_everything",
      ok: false,
      error: { code: "invalid_tool" },
    });

    const terminal = terminalEvents(events);
    expect(terminal[0]).toMatchObject({
      type: "run_completed",
      status: "partial",
      missingMaterial: ["delete_everything"],
    });
  });

  it("isolates a failing tool and continues the run", async () => {
    const model = scriptedModel([
      { kind: "call_tool", intent: { name: "bash", arguments: { command: "npm test" } } },
      { kind: "call_tool", intent: { name: "read", arguments: { path: "a.ts" } } },
      { kind: "respond", content: "Read the file after the failure." },
    ]);
    const tools = fakeTools({
      bash: () => {
        throw new Error("exit 1");
      },
      read: () => "file body",
    });
    const state = initialState(TASK);

    const events = await drive(coreLoopDriver({ model, tools }), state, makeContext());

    expect(state.observations).toHaveLength(2);
    expect(state.observations[0]).toMatchObject({ name: "bash", ok: false });
    expect(state.observations[1]).toMatchObject({ name: "read", ok: true });

    // A tool failure is evidence, not missing material: the run still completes.
    expect(terminalEvents(events)[0]).toMatchObject({
      type: "run_completed",
      status: "complete",
    });
  });
});

describe("core loop — budgets and termination", () => {
  it("fails with budget_iterations instead of looping forever", async () => {
    const tools = fakeTools({ read: () => "same" });
    const model = functionalModel(() => ({
      kind: "call_tool",
      intent: { name: "read", arguments: { path: "a.ts" } },
    }));
    const ctx = makeContext({ budget: { ...DEFAULT_BUDGET, maxIterations: 3 } });

    await expect(drive(coreLoopDriver({ model, tools }), initialState(TASK), ctx)).rejects.toThrow(
      BudgetExceededError,
    );

    await expect(
      drive(coreLoopDriver({ model, tools }), initialState(TASK), makeContext({
        budget: { ...DEFAULT_BUDGET, maxIterations: 3 },
      })),
    ).rejects.toMatchObject({ code: "budget_iterations" });
  });

  it("bounds model turns: N tool calls plus the answering turn need maxIterations >= N+1", async () => {
    const script = (): Decision[] => [
      { kind: "call_tool", intent: { name: "read", arguments: { path: "a.ts" } } },
      { kind: "call_tool", intent: { name: "read", arguments: { path: "b.ts" } } },
      { kind: "call_tool", intent: { name: "read", arguments: { path: "c.ts" } } },
      { kind: "respond", content: "done" },
    ];
    const tools = fakeTools({ read: () => "body" });

    // Four turns fit exactly — including the turn that answers.
    const withinBudget = await drive(
      coreLoopDriver({ model: scriptedModel(script()), tools }),
      initialState(TASK),
      makeContext({ budget: { ...DEFAULT_BUDGET, maxIterations: 4 } }),
    );
    expect(terminalEvents(withinBudget)[0]).toMatchObject({
      type: "run_completed",
      status: "complete",
    });

    // One turn short: the answering turn is refused rather than allowed through.
    await expect(
      drive(
        coreLoopDriver({ model: scriptedModel(script()), tools }),
        initialState(TASK),
        makeContext({ budget: { ...DEFAULT_BUDGET, maxIterations: 3 } }),
      ),
    ).rejects.toMatchObject({ code: "budget_iterations" });
  });

  it("fails with budget_tools when the tool budget is exceeded", async () => {
    const tools = fakeTools({ read: () => "same" });
    const model = functionalModel(() => ({
      kind: "call_tool",
      intent: { name: "read", arguments: { path: "a.ts" } },
    }));

    await expect(
      drive(coreLoopDriver({ model, tools }), initialState(TASK), makeContext({
        budget: { ...DEFAULT_BUDGET, maxToolCalls: 1, maxIterations: 100 },
      })),
    ).rejects.toMatchObject({ code: "budget_tools" });
  });

  it("refuses ask_human when no human input channel is injected", async () => {
    const model = scriptedModel([{ kind: "ask_human", question: "Delete the table?" }]);

    await expect(
      drive(coreLoopDriver({ model, tools: fakeTools({}) }), initialState(TASK), makeContext()),
    ).rejects.toMatchObject({ code: "runtime_error" });
  });

  it("completes a human round trip and re-runs the model with the answer", async () => {
    const model = scriptedModel([
      { kind: "ask_human", question: "Delete the table?" },
      { kind: "respond", content: "Understood, I will not delete it." },
    ]);
    const state = initialState(TASK);
    const asked: string[] = [];

    const events = await drive(
      coreLoopDriver({ model, tools: fakeTools({}) }),
      state,
      makeContext({
        humanInput: async (question) => {
          asked.push(question);
          return "no, do not";
        },
      }),
    );

    expect(asked).toEqual(["Delete the table?"]);
    expect(typesOf(events)).toContain("human_input_requested");
    expect(typesOf(events)).toContain("human_input_received");
    expect(state.transcript.at(-1)).toEqual({ role: "assistant", text: "Understood, I will not delete it." });
    expect(state.iteration).toBe(1);
  });

  it("does not fabricate completion when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = scriptedModel([{ kind: "respond", content: "should never be produced" }]);

    await expect(
      drive(
        coreLoopDriver({ model, tools: fakeTools({}) }),
        initialState(TASK),
        makeContext({ signal: controller.signal }),
      ),
    ).rejects.toThrow();
  });
});

describe("core loop — replay equivalence", () => {
  it("reconstructs the exact live AgentState from the event log", async () => {
    const model = scriptedModel([
      { kind: "ask_human", question: "Proceed with the migration?" },
      { kind: "call_tool", intent: { name: "read", arguments: { path: "schema.sql" } } },
      { kind: "call_tool", intent: { name: "bash", arguments: { command: "npm test" } } },
      { kind: "call_tool", intent: { name: "ghost", arguments: {} } },
      { kind: "respond", content: "Migration reviewed; the ghost tool is unavailable." },
    ]);
    const tools = fakeTools({
      read: () => "CREATE TABLE users(id INTEGER);",
      bash: () => {
        throw new Error("exit 1");
      },
    });
    const state = initialState(TASK);

    const events = await drive(
      coreLoopDriver({ model, tools }),
      state,
      makeContext({ humanInput: async () => "yes, continue" }),
    );

    const { state: replayed, terminal } = replayAgentState(events, TASK);

    expect(replayed).toEqual(state);
    expect(terminal?.type).toBe("run_completed");
    expect(terminal).toMatchObject({ status: "partial", missingMaterial: ["ghost"] });
  });

  it("replays idempotently even when events arrive out of order", async () => {
    const model = scriptedModel([
      { kind: "call_tool", intent: { name: "read", arguments: { path: "a.ts" } } },
      { kind: "respond", content: "done" },
    ]);
    const events = await drive(
      coreLoopDriver({ model, tools: fakeTools({ read: () => "body" }) }),
      initialState(TASK),
      makeContext(),
    );

    const shuffled = [...events].reverse();
    expect(replayAgentState(shuffled, TASK).state).toEqual(replayAgentState(events, TASK).state);
    expect(replayAgentState(events, TASK).state).toEqual(replayAgentState(events, TASK).state);
  });
});
