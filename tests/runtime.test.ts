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
  type AgentEvent,
  type RunError,
  type Task,
} from "../src/core/contracts.ts";
import { coreLoopDriver, type RunDriver } from "../src/core/loop.ts";
import { fakeTools, scriptedModel } from "../src/adapters/fake/index.ts";
import { AgentRuntime, backoffDelayMs, createRuntime } from "../src/runtime/runtime.ts";
import { InMemoryRunLog, JsonlRunLog, parseEventLog } from "../src/runtime/run-log.ts";
import { InMemorySessionStore, JsonSessionStore } from "../src/runtime/session-store.ts";
import { functionalModel } from "../src/adapters/fake/index.ts";

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
    // Real backoff would make these tests slow and time-dependent; the retry
    // behaviour under test is the scheduling, not the wall clock.
    sleep: async () => true,
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
    const { runtime, runLog } = await makeRuntime(hangingDriver, {
      budget: { ...DEFAULT_BUDGET, timeoutMs: 30_000 },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const events = await collect(runtime.run(TASK, controller.signal));

    expect(terminals(events)[0]?.type).toBe("run_cancelled");

    // Cancellation must be *persisted*, not merely observed: a restart has to be able
    // to tell a cancelled run from one that is still going.
    const runId = events[0]?.runId as string;
    expect((await runLog.loadRun(runId))?.status).toBe("cancelled");
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

    // Each runtime is bound to its own workspace, so each task must name that one.
    const firstTask = { ...TASK, cwd: "/tmp/ws-a" };
    const secondTask = { ...TASK, cwd: "/tmp/ws-b" };

    const firstEvents = await collect(first.run(firstTask));
    const secondEvents = await collect(second.run(secondTask));

    expect(first.session.id).not.toBe(second.session.id);
    expect(firstEvents[0]?.runId).not.toBe(secondEvents[0]?.runId);

    const firstState = await first.finalState(firstEvents[0]?.runId as string, firstTask);
    const secondState = await second.finalState(secondEvents[0]?.runId as string, secondTask);

    expect(firstState.observations).toHaveLength(1);
    expect(secondState.observations).toHaveLength(0);
    expect(first.session.runs).toHaveLength(1);
    expect(second.session.runs).toHaveLength(1);
  });
});

/** Fails retryably for the first `failures` attempts, then succeeds. */
function flakyDriver(failures: number, error: RunError): RunDriver {
  let calls = 0;
  return async function* () {
    calls += 1;
    if (calls <= failures) {
      yield { type: "run_failed", error };
      return;
    }
    yield { type: "run_completed", status: "complete", result: "recovered" };
  };
}

const RETRYABLE: RunError = { code: "provider_unavailable", message: "503 Service Unavailable" };
const NOT_RETRYABLE: RunError = { code: "auth", message: "401 Unauthorized" };

describe("runtime — a signal that is already aborted", () => {
  it("cancels immediately without asking the model anything", async () => {
    const model = scriptedModel([{ kind: "respond", content: "should never be produced" }]);
    const { runtime } = await makeRuntime(
      coreLoopDriver({ model, tools: fakeTools({ read: () => "body" }) }),
    );

    const controller = new AbortController();
    controller.abort();

    const events = await collect(runtime.run(TASK, controller.signal));

    expect(terminals(events)).toHaveLength(1);
    expect(terminals(events)[0]?.type).toBe("run_cancelled");
    // The model was never consulted, so no work was started at all.
    expect(model.calls).toBe(0);
    expect(events.some((event) => event.type === "tool_started")).toBe(false);
  });

  it("records the run as cancelled rather than leaving it running", async () => {
    const { runtime, runLog } = await makeRuntime(
      coreLoopDriver({
        model: scriptedModel([{ kind: "respond", content: "x" }]),
        tools: fakeTools({}),
      }),
    );
    const controller = new AbortController();
    controller.abort();

    const events = await collect(runtime.run(TASK, controller.signal));
    const runId = events[0]?.runId as string;

    expect((await runLog.loadRun(runId))?.status).toBe("cancelled");
  });
});

describe("runtime — bounded, visible retry", () => {
  it("retries a retryable failure and completes", async () => {
    const { runtime } = await makeRuntime(flakyDriver(2, RETRYABLE), {
      budget: { ...DEFAULT_BUDGET, maxRetries: 2 },
    });

    const events = await collect(runtime.run(TASK));

    expect(events.filter((event) => event.type === "retry_scheduled")).toHaveLength(2);
    expect(terminals(events)).toHaveLength(1);
    expect(terminals(events)[0]?.type).toBe("run_completed");
  });

  it("does not log a terminal event for an attempt that will be retried", async () => {
    const { runtime } = await makeRuntime(flakyDriver(1, RETRYABLE), {
      budget: { ...DEFAULT_BUDGET, maxRetries: 2 },
    });

    const events = await collect(runtime.run(TASK));

    // The failed attempt must not appear as a run_failed: that would read as two
    // runs in one log.
    expect(events.filter((event) => event.type === "run_failed")).toHaveLength(0);
    const retry = events.find((event) => event.type === "retry_scheduled");
    expect(retry).toMatchObject({ attempt: 2, maxAttempts: 3, delayMs: 250 });
  });

  it("stops retrying at maxRetries and reports the last failure", async () => {
    const { runtime } = await makeRuntime(flakyDriver(9, RETRYABLE), {
      budget: { ...DEFAULT_BUDGET, maxRetries: 1 },
    });

    const events = await collect(runtime.run(TASK));

    expect(events.filter((event) => event.type === "retry_scheduled")).toHaveLength(1);
    expect(terminals(events)).toHaveLength(1);
    expect(terminals(events)[0]).toMatchObject({
      type: "run_failed",
      error: { code: "provider_unavailable" },
    });
  });

  it("never retries a non-retryable failure", async () => {
    const { runtime } = await makeRuntime(flakyDriver(9, NOT_RETRYABLE), {
      budget: { ...DEFAULT_BUDGET, maxRetries: 3 },
    });

    const events = await collect(runtime.run(TASK));

    expect(events.filter((event) => event.type === "retry_scheduled")).toHaveLength(0);
    expect(terminals(events)[0]).toMatchObject({ type: "run_failed", error: { code: "auth" } });
  });

  it("does not retry when a cancellation arrives during the backoff", async () => {
    const controller = new AbortController();
    const { runtime } = await makeRuntime(flakyDriver(9, RETRYABLE), {
      budget: { ...DEFAULT_BUDGET, maxRetries: 3 },
      sleep: async () => {
        controller.abort();
        return false; // aborted, not slept
      },
    });

    const events = await collect(runtime.run(TASK, controller.signal));

    expect(terminals(events)).toHaveLength(1);
    expect(terminals(events)[0]?.type).toBe("run_cancelled");
  });

  it("backs off exponentially and caps the delay", () => {
    expect(backoffDelayMs(1)).toBe(250);
    expect(backoffDelayMs(2)).toBe(500);
    expect(backoffDelayMs(3)).toBe(1_000);
    // Capped rather than unbounded, so a long retry chain cannot stall for minutes.
    expect(backoffDelayMs(20)).toBe(4_000);
  });
});

describe("runtime — waiting for a human is a durable state", () => {
  const askingDriver: RunDriver = async function* (_state, ctx) {
    yield { type: "human_input_requested", question: "Rewrite the migration?" };
    const answer = await ctx.humanInput?.("Rewrite the migration?", ctx.signal);
    yield { type: "human_input_received", input: answer };
    yield { type: "run_completed", status: "complete", result: "left it alone" };
  };

  it("marks the run awaiting_human while the question is open, then resumes it", async () => {
    const { runtime, runLog } = await makeRuntime(askingDriver, {
      humanInput: async () => "no",
    });

    const events: AgentEvent[] = [];
    let statusWhileWaiting: string | undefined;
    let runId: string | undefined;

    for await (const event of runtime.run(TASK)) {
      events.push(event);
      runId ??= event.runId;
      if (event.type === "human_input_requested") {
        // The save is fire-and-forget; let it land before observing.
        await Promise.resolve();
        statusWhileWaiting = (await runLog.loadRun(event.runId))?.status;
      }
    }

    expect(statusWhileWaiting).toBe("awaiting_human");
    expect(events.map((event) => event.type)).toContain("run_resumed");
    expect(terminals(events)[0]).toMatchObject({ type: "run_completed" });
    expect((await runLog.loadRun(runId as string))?.status).toBe("completed");
  });

  it("places run_resumed immediately after the human's answer", async () => {
    const { runtime } = await makeRuntime(askingDriver, { humanInput: async () => "no" });

    const events = await collect(runtime.run(TASK));
    const answered = events.findIndex((event) => event.type === "human_input_received");

    expect(answered).toBeGreaterThan(-1);
    expect(events[answered + 1]?.type).toBe("run_resumed");
  });
});

describe("runtime — concurrency", () => {
  it("survives concurrent saves of the same session", async () => {
    const directory = await tempDir();
    const store = await JsonSessionStore.open(directory, idGenerator());
    const session = await store.createSession();

    // Write-then-rename is the right shape, but a *fixed* temporary name means two
    // concurrent saves of one session can interleave or race the rename.
    await Promise.all(
      Array.from({ length: 25 }, (_unused, index) =>
        store.saveSession({
          ...session,
          runs: [
            {
              runId: `r${index}`,
              sessionId: session.id,
              task: TASK,
              status: "completed",
              startedAt: index,
              updatedAt: index,
            },
          ],
        }),
      ),
    );

    const loaded = await store.loadSession(session.id);
    expect(loaded, "the session file must still be readable JSON").toBeDefined();
    expect(Array.isArray(loaded?.runs)).toBe(true);
  }, 20_000);

  it("keeps two concurrent runs in one session separate and both persisted", async () => {
    const directory = await tempDir();
    const runLog = await JsonlRunLog.open(directory);
    const sessionStore = await JsonSessionStore.open(directory, idGenerator());

    const runtime = await createRuntime({
      cwd: "/tmp/ws",
      // Always answers, so two concurrent runs do not exhaust a script.
      driver: coreLoopDriver({
        model: functionalModel(() => ({ kind: "respond", content: "done" })),
        tools: fakeTools({}),
      }),
      runLog,
      sessionStore,
      newId: idGenerator(),
      sleep: async () => true,
    });

    const [first, second] = await Promise.all([collect(runtime.run(TASK)), collect(runtime.run(TASK))]);

    expect(terminals(first)[0]?.type).toBe("run_completed");
    expect(terminals(second)[0]?.type).toBe("run_completed");
    expect(first[0]?.runId).not.toBe(second[0]?.runId);

    // Each run's events must land in its own log, not a shared one.
    const runs = await runLog.listRuns();
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      const events = await runLog.listEvents(run.runId);
      expect(events.length).toBeGreaterThan(0);
      expect(new Set(events.map((event) => event.runId))).toEqual(new Set([run.runId]));
    }
  }, 20_000);
});

describe("recovery — damaged durable state", () => {
  it("clearly reports a corrupt session file instead of leaking a parse error", async () => {
    const directory = await tempDir();
    const store = await JsonSessionStore.open(directory, idGenerator());
    const session = await store.createSession();

    // A truncated write, or damage from outside the process.
    await fs.writeFile(
      path.join(directory, "sessions", `${session.id}.json`),
      '{"id":"x","runs":[',
      "utf8",
    );

    let failure: { code?: string; message?: string } | undefined;
    try {
      await store.loadSession(session.id);
    } catch (error) {
      failure = error as { code?: string; message?: string };
    }

    // The exit criterion is that a restart recovers, or *clearly reports why it cannot*.
    // A bare SyntaxError from JSON.parse is not a clear report.
    expect(failure, "a damaged session file should not load silently").toBeDefined();
    expect(failure?.code).toBe("runtime_error");
    expect(failure?.message).toContain(session.id);
  });

  it("rejects a file that is valid JSON but not a session record", async () => {
    const directory = await tempDir();
    const store = await JsonSessionStore.open(directory, idGenerator());
    const session = await store.createSession();

    // Parses cleanly, so a JSON.parse-only guard would hand back a broken session and
    // the failure would surface much later, somewhere unrelated.
    await fs.writeFile(
      path.join(directory, "sessions", `${session.id}.json`),
      '{"unexpected":true}',
      "utf8",
    );

    await expect(store.loadSession(session.id)).rejects.toMatchObject({
      code: "runtime_error",
    });
  });

  it("still loads an intact session alongside a damaged neighbour", async () => {
    const directory = await tempDir();
    const store = await JsonSessionStore.open(directory, idGenerator());
    const good = await store.createSession();
    const damaged = await store.createSession();

    await fs.writeFile(
      path.join(directory, "sessions", `${damaged.id}.json`),
      "not json at all",
      "utf8",
    );

    // One bad file must not make the good one unreachable.
    const loaded = await store.loadSession(good.id);
    expect(loaded?.id).toBe(good.id);
    // And listing skips the unreadable one rather than failing wholesale.
    expect((await store.listSessions()).map((s) => s.id)).toContain(good.id);
  });
});

describe("runtime — the workspace a run is bound to", () => {
  it("refuses a task whose cwd disagrees with the one the tools are bound to", async () => {
    const runLog = new InMemoryRunLog();
    const sessionStore = new InMemorySessionStore(idGenerator());

    const runtime = await createRuntime({
      cwd: "/workspace",
      driver: coreLoopDriver({
        model: scriptedModel([{ kind: "respond", content: "done" }]),
        tools: fakeTools({}),
      }),
      runLog,
      sessionStore,
      newId: idGenerator(),
      sleep: async () => true,
    });

    // The tool port is confined to /workspace. A task naming anywhere else would run
    // its commands in one directory while the persisted run record claimed another —
    // and the gate would be resolving paths against the wrong root.
    await expect(
      collect(runtime.run({ id: "t", input: "work", cwd: "/somewhere/else" })),
    ).rejects.toMatchObject({ code: "runtime_error" });

    // The matching case still runs.
    const events = await collect(runtime.run({ id: "t", input: "work", cwd: "/workspace" }));
    expect(terminals(events)[0]?.type).toBe("run_completed");
  });

  it("accepts a cwd that differs only by a trailing separator", async () => {
    const runLog = new InMemoryRunLog();
    const sessionStore = new InMemorySessionStore(idGenerator());
    const runtime = await createRuntime({
      cwd: "/workspace",
      driver: coreLoopDriver({
        model: scriptedModel([{ kind: "respond", content: "done" }]),
        tools: fakeTools({}),
      }),
      runLog,
      sessionStore,
      newId: idGenerator(),
      sleep: async () => true,
    });

    const events = await collect(runtime.run({ id: "t", input: "work", cwd: "/workspace/" }));
    expect(terminals(events)[0]?.type).toBe("run_completed");
  });
});
