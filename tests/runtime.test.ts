/**
 * Runtime tests.
 *
 * These prove the guarantees the Runtime exists to provide, not the loop
 * semantics (those are in core-loop.test.ts). Every test here targets an invariant
 * that would silently produce a dishonest run if it broke: lost terminal states,
 * conflated cancellation, hidden persistence stalls, or logs that cannot be replayed.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_BUDGET,
  initialState,
  type AgentEvent,
  type Task,
} from "../src/core/contracts.ts";
import { coreLoopDriver, type RunDriver } from "../src/core/loop.ts";
import { fakeTools, scriptedModel } from "../src/adapters/fake/index.ts";
import { AgentRuntime, createRuntime } from "../src/runtime/runtime.ts";
import { InMemoryRunLog, JsonlRunLog, parseEventLog } from "../src/runtime/run-log.ts";
import { InMemorySessionStore, JsonSessionStore } from "../src/runtime/session-store.ts";

const TASK: Task = { id: "task-1", input: "do the thing", cwd: "/tmp/ws" };

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tinycode-rt-"));
  directories.push(dir);
  return dir;
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const TERMINALS = new Set(["run_completed", "run_failed", "run_cancelled"]);

function terminals(events: readonly AgentEvent[]): AgentEvent[] {
  return events.filter((event) => TERMINALS.has(event.type));
}

let counter = 0;
function idGenerator(): () => string {
  return () => `id-${(counter += 1)}`;
}

interface Harness {
  runtime: AgentRuntime;
  runLog: InMemoryRunLog;
}

async function makeRuntime(
  driver: RunDriver,
  overrides: Partial<ConstructorParameters<typeof AgentRuntime>[1]> = {},
): Promise<Harness> {
  const runLog = new InMemoryRunLog();
  const sessionStore = new InMemorySessionStore(idGenerator());
  const runtime = await createRuntime({
    cwd: "/tmp/ws",
    driver,
    runLog,
    sessionStore,
    newId: idGenerator(),
    ...overrides,
  });
  return { runtime, runLog };
}

/** A driver that never emits a terminal event and waits for cancellation. */
const hangingDriver: RunDriver = async function* (_state, ctx) {
  yield { type: "model_requested" };
  await new Promise<never>((_resolve, reject) => {
    ctx.signal.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
      { once: true },
    );
  });
};

/** A driver that stops without saying how the run ended and produced nothing. */
const silentDriver: RunDriver = async function* () {
  return;
};

describe("runtime — lifecycle guarantees", () => {
  it("starts with run_started and ends with exactly one terminal event", async () => {
    const { runtime } = await makeRuntime(
      coreLoopDriver({
        model: scriptedModel([{ kind: "respond", content: "done" }]),
        tools: fakeTools({}),
      }),
    );

    const events = await collect(runtime.run(TASK));

    expect(events[0]?.type).toBe("run_started");
    expect(terminals(events)).toHaveLength(1);
    expect(terminals(events)[0]?.type).toBe("run_completed");
  });

  it("mints a strictly monotonic sequence starting at zero", async () => {
    const { runtime } = await makeRuntime(
      coreLoopDriver({
        model: scriptedModel([
          { kind: "call_tool", intent: { name: "read", arguments: { path: "a.ts" } } },
          { kind: "respond", content: "done" },
        ]),
        tools: fakeTools({ read: () => "body" }),
      }),
    );

    const events = await collect(runtime.run(TASK));

    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index));
  });

  it("records the run as completed in the run log", async () => {
    const { runtime, runLog } = await makeRuntime(
      coreLoopDriver({
        model: scriptedModel([{ kind: "respond", content: "done" }]),
        tools: fakeTools({}),
      }),
    );

    const events = await collect(runtime.run(TASK));
    const runId = events[0]?.runId;

    expect(runId).toBeDefined();
    const run = await runLog.loadRun(runId as string);
    expect(run?.status).toBe("completed");
    expect(run?.sessionId).toBe(runtime.session.id);
  });
});

describe("runtime — termination is never fabricated", () => {
  it("classifies a caller cancellation as run_cancelled, not a failure", async () => {
    const { runtime } = await makeRuntime(hangingDriver, {
      budget: { ...DEFAULT_BUDGET, timeoutMs: 30_000 },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const events = await collect(runtime.run(TASK, controller.signal));

    expect(terminals(events)[0]?.type).toBe("run_cancelled");
  });

  it("distinguishes a time-budget expiry from a user cancellation", async () => {
    const { runtime } = await makeRuntime(hangingDriver, {
      budget: { ...DEFAULT_BUDGET, timeoutMs: 120 },
    });

    const events = await collect(runtime.run(TASK));

    const terminal = terminals(events)[0];
    expect(terminal?.type).toBe("run_failed");
    expect(terminal).toMatchObject({ error: { code: "budget_timeout" } });
  });

  it("reports no_progress when a driver stops silently without evidence", async () => {
    const { runtime } = await makeRuntime(silentDriver);

    const events = await collect(runtime.run(TASK));

    expect(terminals(events)[0]).toMatchObject({
      type: "run_failed",
      error: { code: "no_progress" },
    });
  });

  it("distinguishes a silent stop with evidence from a true no-progress stop", async () => {
    const evidenceOnlyDriver: RunDriver = async function* (state, ctx) {
      const observation = { name: "read", ok: true, durationMs: 1, observedAt: ctx.now() };
      state.observations.push(observation);
      yield { type: "observation_added", name: "read", observation };
    };
    const { runtime } = await makeRuntime(evidenceOnlyDriver);

    const events = await collect(runtime.run(TASK));

    expect(terminals(events)[0]).toMatchObject({
      type: "run_failed",
      error: { code: "runtime_error" },
    });
  });

  it("normalizes a thrown provider error into the taxonomy", async () => {
    const throwingDriver: RunDriver = async function* () {
      throw new Error("402 Insufficient Balance");
    };
    const { runtime } = await makeRuntime(throwingDriver);

    const events = await collect(runtime.run(TASK));

    expect(terminals(events)[0]).toMatchObject({
      type: "run_failed",
      error: { code: "provider_unavailable" },
    });
  });

  it("emits usage even when the driver never reports it", async () => {
    const { runtime } = await makeRuntime(silentDriver);

    const events = await collect(runtime.run(TASK));

    expect(events.filter((event) => event.type === "usage_reported")).toHaveLength(1);
  });
});

describe("runtime — persistence", () => {
  it("persists every event and replays the exact final state", async () => {
    const driver = coreLoopDriver({
      model: scriptedModel([
        { kind: "call_tool", intent: { name: "read", arguments: { path: "a.ts" } } },
        { kind: "call_tool", intent: { name: "ghost", arguments: {} } },
        { kind: "respond", content: "finished" },
      ]),
      tools: fakeTools({ read: () => "file body" }),
    });
    const { runtime, runLog } = await makeRuntime(driver);

    const events = await collect(runtime.run(TASK));
    const runId = events[0]?.runId as string;

    const persisted = await runLog.listEvents(runId);
    expect(persisted).toHaveLength(events.length);

    // The log, not the in-memory stream, must be able to rebuild the state.
    const recovered = await runtime.recover(runId, TASK);
    expect(recovered.state.observations).toHaveLength(2);
    expect(recovered.terminal?.type).toBe("run_completed");

    const live = await runtime.finalState(runId, TASK);
    expect(live).toEqual(recovered.state);
  });

  it("completes the run even when every persistence write fails", async () => {
    const failures: unknown[] = [];
    const brokenLog = new InMemoryRunLog();
    brokenLog.appendEvent = async () => {
      throw new Error("disk full");
    };

    const sessionStore = new InMemorySessionStore(idGenerator());
    const runtime = await createRuntime({
      cwd: "/tmp/ws",
      driver: coreLoopDriver({
        model: scriptedModel([{ kind: "respond", content: "done" }]),
        tools: fakeTools({}),
      }),
      runLog: brokenLog,
      sessionStore,
      newId: idGenerator(),
      onPersistenceError: (error) => failures.push(error),
    });

    const events = await collect(runtime.run(TASK));

    // Auditing is a side channel: the run still terminates honestly.
    expect(terminals(events)[0]?.type).toBe("run_completed");
    expect(failures.length).toBeGreaterThan(0);
  });

  it("survives a torn final line in the event log", () => {
    const good = JSON.stringify({
      type: "run_started",
      runId: "r1",
      sequence: 0,
      timestamp: 1,
    });

    const parsed = parseEventLog(`${good}\n{"type":"text_delta","runId":"r1","sequ`);

    expect(parsed.events).toHaveLength(1);
    expect(parsed.skippedLineNumbers).toEqual([2]);
  });

  it("round-trips through a real JSONL directory and recovers after a restart", async () => {
    const directory = await tempDir();
    const runLog = await JsonlRunLog.open(directory);
    const sessionStore = await JsonSessionStore.open(directory, idGenerator());

    const runtime = await createRuntime({
      cwd: "/tmp/ws",
      driver: coreLoopDriver({
        model: scriptedModel([
          { kind: "call_tool", intent: { name: "read", arguments: { path: "a.ts" } } },
          { kind: "respond", content: "persisted" },
        ]),
        tools: fakeTools({ read: () => "body" }),
      }),
      runLog,
      sessionStore,
      newId: idGenerator(),
    });

    const events = await collect(runtime.run(TASK));
    const runId = events[0]?.runId as string;

    // A fresh process would construct new stores over the same directory.
    const reopenedLog = await JsonlRunLog.open(directory);
    const reopenedSessions = await JsonSessionStore.open(directory, idGenerator());
    const restarted = new AgentRuntime(
      (await reopenedSessions.loadSession(runtime.session.id)) ?? runtime.session,
      {
        cwd: "/tmp/ws",
        driver: silentDriver,
        runLog: reopenedLog,
        sessionStore: reopenedSessions,
        newId: idGenerator(),
      },
    );

    const recovered = await restarted.recover(runId, TASK);

    expect(recovered.terminal?.type).toBe("run_completed");
    expect(recovered.state.observations).toHaveLength(1);

    // One run, listed once, in its final state — not once per state change.
    const runs = await reopenedLog.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId, status: "completed" });
  });
});

describe("runtime — session isolation", () => {
  it("keeps two sessions' runs and events separate", async () => {
    const runLog = new InMemoryRunLog();
    const sessionStore = new InMemorySessionStore(idGenerator());

    const first = await createRuntime({
      cwd: "/tmp/ws-a",
      driver: coreLoopDriver({
        model: scriptedModel([
          { kind: "call_tool", intent: { name: "read", arguments: { path: "a.ts" } } },
          { kind: "respond", content: "a" },
        ]),
        tools: fakeTools({ read: () => "from a" }),
      }),
      runLog,
      sessionStore,
      newId: idGenerator(),
    });

    const second = await createRuntime({
      cwd: "/tmp/ws-b",
      driver: coreLoopDriver({
        model: scriptedModel([{ kind: "respond", content: "b" }]),
        tools: fakeTools({ read: () => "from b" }),
      }),
      runLog,
      sessionStore,
      newId: idGenerator(),
    });

    const firstEvents = await collect(first.run(TASK));
    const secondEvents = await collect(second.run(TASK));

    expect(first.session.id).not.toBe(second.session.id);
    expect(firstEvents[0]?.runId).not.toBe(secondEvents[0]?.runId);

    const firstState = await first.finalState(firstEvents[0]?.runId as string, TASK);
    const secondState = await second.finalState(secondEvents[0]?.runId as string, TASK);

    expect(firstState.observations).toHaveLength(1);
    expect(secondState.observations).toHaveLength(0);
    expect(first.session.runs).toHaveLength(1);
    expect(second.session.runs).toHaveLength(1);
  });
});
